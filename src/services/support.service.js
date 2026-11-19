// Member support: FAQs and tickets. Staff replies are shown without the staff member's identity.
// Guests create tickets with contactName/contactEmail and null userId.

import { FAQS } from '../config/catalog.js';
import { GUEST_AUTHOR_ID, SupportTicket } from '../models/SupportTicket.js';
import { Profile } from '../models/Profile.js';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { buildPage, getAfterCursorFilter, getPageSort } from '../utils/pagination.js';

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
export async function createTicket(userId, { category, subject, message, name, email }) {
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

  const ticket = await SupportTicket.create({
    userId: userId || null,
    contactName,
    contactEmail,
    category,
    subject,
    messages: [{ author: 'USER', authorId, body: message }],
  });
  return presentTicketForMember(ticket);
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
export async function replyToTicket(userId, ticketId, { body }) {
  const ticket = await SupportTicket.findOne({ _id: ticketId, userId });
  if (!ticket) throw ApiError.notFound();
  if (ticket.status === 'CLOSED') {
    throw ApiError.conflict('This ticket is closed. Open a new request if you still need help.');
  }

  ticket.messages.push({ author: 'USER', authorId: userId, body });
  if (ticket.status === 'OPEN' || ticket.status === 'RESOLVED') {
    ticket.status = 'IN_PROGRESS';
  }
  await ticket.save();
  return presentTicketForMember(ticket.toObject());
}
