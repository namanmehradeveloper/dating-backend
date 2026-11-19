// Member support: FAQs and tickets. Staff replies are shown without the staff member's identity.
// Guests create tickets with contactName/contactEmail and null userId.
// Creates use atomic daily quota + Idempotency-Key; member replies dedupe by message idempotencyKey.

import { FAQS } from '../config/catalog.js';
import { GUEST_AUTHOR_ID, SupportTicket } from '../models/SupportTicket.js';
import { Profile } from '../models/Profile.js';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { buildPage, getAfterCursorFilter, getPageSort } from '../utils/pagination.js';
import { byIp } from '../utils/rateLimit.js';
import { consumeTicketQuota, releaseTicketQuota, ticketQuotaKey } from './supportQuota.service.js';

// Returns the FAQ list shown in the help centre.
export function listFaqs() {
  return FAQS;
}

// Shapes a ticket for its owner. Staff ids stay private; only "STAFF" is shown as the author.
export function presentTicketForMember(ticket) {
  return {
    id: ticket._id,
    category: ticket.category,
    subject: ticket.subject,
    status: ticket.status,
    contactName: ticket.contactName ?? null,
    contactEmail: ticket.contactEmail ?? null,
    createdAt: ticket.createdAt,
    messages: ticket.messages.map((message) => ({
      id: message._id,
      author: message.author,
      body: message.body,
      createdAt: message.createdAt,
    })),
  };
}

// Resolves contact fields for an authenticated member when the client omitted name/email.
async function resolveContactForMember(userId, { name, email }) {
  const [user, profile] = await Promise.all([
    User.findById(userId).select('email').lean(),
    Profile.findOne({ userId }).select('displayName').lean(),
  ]);
  if (!user) throw ApiError.unauthenticated();

  const contactName = name || profile?.displayName || null;
  const contactEmail = email || user.email || null;
  const details = [];
  if (!contactName) details.push({ field: 'name', reason: 'REQUIRED' });
  if (!contactEmail) details.push({ field: 'email', reason: 'REQUIRED' });
  if (details.length) throw ApiError.validation(details);

  return { contactName, contactEmail };
}

// Opens a ticket with the member's (or guest's) first message.
// `idempotencyKey` + quota key come from the request (middleware + IP).
export async function createTicket(userId, { category, subject, message, name, email }, { idempotencyKey, ipKey } = {}) {
  let contactName;
  let contactEmail;
  let authorId;

  if (userId) {
    ({ contactName, contactEmail } = await resolveContactForMember(userId, { name, email }));
    authorId = userId;
  } else {
    contactName = name;
    contactEmail = email;
    authorId = GUEST_AUTHOR_ID;
  }

  if (idempotencyKey) {
    const existingByKey = await SupportTicket.findOne({ idempotencyKey }).lean();
    if (existingByKey) {
      if (userId && existingByKey.userId !== userId) {
        throw ApiError.conflict('This Idempotency-Key was already used for a different request.', [
          { field: 'Idempotency-Key', reason: 'REUSED' },
        ]);
      }
      return presentTicketForMember(existingByKey);
    }
  }

  const quotaKey = ticketQuotaKey({ userId, ipKey });
  await consumeTicketQuota(quotaKey);

  try {
    const ticket = await SupportTicket.create({
      userId: userId || null,
      contactName,
      contactEmail,
      category,
      subject,
      idempotencyKey: idempotencyKey || undefined,
      messages: [{ author: 'USER', authorId, body: message, idempotencyKey: idempotencyKey || undefined }],
    });
    return presentTicketForMember(ticket);
  } catch (error) {
    await releaseTicketQuota(quotaKey);
    if (error?.code === 11000 && idempotencyKey) {
      const existing = await SupportTicket.findOne({ idempotencyKey }).lean();
      if (existing) return presentTicketForMember(existing);
    }
    throw error;
  }
}

// Returns one of the member's own tickets. Other members' tickets are 404. Guests cannot fetch.
export async function getTicket(userId, ticketId) {
  const ticket = await SupportTicket.findOne({ _id: ticketId, userId }).lean();
  if (!ticket) throw ApiError.notFound();
  return presentTicketForMember(ticket);
}

// GET /support/tickets — authenticated member's own tickets, newest first.
export async function listTickets(userId, { limit, cursor }) {
  const docs = await SupportTicket.find({ userId, ...getAfterCursorFilter(cursor) })
    .sort(getPageSort())
    .limit(limit + 1)
    .lean();
  const page = buildPage(docs, limit);
  return {
    items: page.items.map((ticket) => {
      const last = ticket.messages[ticket.messages.length - 1];
      return {
        id: ticket._id,
        category: ticket.category,
        subject: ticket.subject,
        status: ticket.status,
        contactName: ticket.contactName ?? null,
        contactEmail: ticket.contactEmail ?? null,
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
        messageCount: ticket.messages.length,
        lastMessageAt: last?.createdAt ?? ticket.createdAt,
        lastMessageAuthor: last?.author ?? null,
        lastMessagePreview: last?.body
          ? (last.body.length > 120 ? `${last.body.slice(0, 117)}…` : last.body)
          : null,
      };
    }),
    nextCursor: page.nextCursor,
  };
}

// POST /support/tickets/:ticketId/messages — owner follow-up. CLOSED tickets reject.
// Concurrent / retried inserts with the same idempotencyKey return the existing ticket once.
export async function replyToTicket(userId, ticketId, { body }, { idempotencyKey } = {}) {
  const owned = await SupportTicket.findOne({ _id: ticketId, userId }).lean();
  if (!owned) throw ApiError.notFound();
  if (owned.status === 'CLOSED') {
    throw ApiError.conflict('This ticket is closed. Open a new request if you still need help.');
  }

  if (idempotencyKey) {
    const already = owned.messages?.find((message) => message.idempotencyKey === idempotencyKey);
    if (already) return presentTicketForMember(owned);
  }

  const message = {
    author: 'USER',
    authorId: userId,
    body,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };

  const filter = {
    _id: ticketId,
    userId,
    status: { $ne: 'CLOSED' },
  };
  if (idempotencyKey) {
    filter.$nor = [{ messages: { $elemMatch: { idempotencyKey } } }];
  }

  const updated = await SupportTicket.findOneAndUpdate(
    filter,
    {
      $push: { messages: message },
      $set: {
        status: owned.status === 'OPEN' || owned.status === 'RESOLVED' ? 'IN_PROGRESS' : owned.status,
      },
    },
    { returnDocument: 'after' },
  ).lean();

  if (updated) return presentTicketForMember(updated);

  // Lost the race or ticket closed between checks — reload and resolve.
  const latest = await SupportTicket.findOne({ _id: ticketId, userId }).lean();
  if (!latest) throw ApiError.notFound();
  if (latest.status === 'CLOSED') {
    throw ApiError.conflict('This ticket is closed. Open a new request if you still need help.');
  }
  if (idempotencyKey && latest.messages?.some((entry) => entry.idempotencyKey === idempotencyKey)) {
    return presentTicketForMember(latest);
  }
  throw ApiError.conflict('Could not save this reply. Please retry with a new Idempotency-Key.');
}

// Helper for controllers that need the guest IP quota key.
export function guestIpKeyFromRequest(req) {
  return byIp(req);
}
