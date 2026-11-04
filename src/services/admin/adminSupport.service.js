// Support desk for staff: list and read tickets, change their status and reply to members.

import { SupportTicket } from '../../models/SupportTicket.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPage, getAfterCursorFilter, getPageSort } from '../../utils/pagination.js';
import { recordAudit } from '../audit.service.js';
import { notifyUser } from '../notification.service.js';
import { loadUserCards } from './adminPresenter.js';

// Shapes one ticket row.
function presentTicketSummary(ticket, cardFor) {
  const lastMessage = ticket.messages[ticket.messages.length - 1];
  return {
    id: ticket._id,
    category: ticket.category,
    subject: ticket.subject,
    status: ticket.status,
    user: cardFor(ticket.userId),
    messageCount: ticket.messages.length,
    lastMessageAt: lastMessage?.createdAt ?? ticket.createdAt,
    lastMessageAuthor: lastMessage?.author ?? null,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}

// GET /admin/support/tickets — newest first, filtered by status and category.
export async function listTickets(filters, { limit, cursor }) {
  const query = {};
  if (filters.status) query.status = filters.status;
  if (filters.category) query.category = filters.category;
  if (filters.q) {
    const pattern = new RegExp(filters.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [{ subject: pattern }, { _id: filters.q }, { userId: filters.q }];
  }
  const docs = await SupportTicket.find({ ...query, ...getAfterCursorFilter(cursor) }).sort(getPageSort()).limit(limit + 1).lean();
  const page = buildPage(docs, limit);
  const cardFor = await loadUserCards(page.items.map((ticket) => ticket.userId));
  return { items: page.items.map((ticket) => presentTicketSummary(ticket, cardFor)), nextCursor: page.nextCursor };
}

// GET /admin/support/tickets/:ticketId — the full conversation, with staff authors identified.
export async function getTicket(ticketId) {
  const ticket = await SupportTicket.findById(ticketId).lean();
  if (!ticket) throw ApiError.notFound();
  const cardFor = await loadUserCards([ticket.userId, ...ticket.messages.map((message) => message.authorId)]);
  return {
    ...presentTicketSummary(ticket, cardFor),
    messages: ticket.messages.map((message) => ({
      id: message._id,
      author: message.author,
      authorUser: cardFor(message.authorId),
      body: message.body,
      createdAt: message.createdAt,
    })),
  };
}

// PATCH /admin/support/tickets/:ticketId — change the status.
export async function updateTicketStatus(actor, ticketId, { status }) {
  const ticket = await SupportTicket.findById(ticketId);
  if (!ticket) throw ApiError.notFound();
  const previousStatus = ticket.status;
  ticket.status = status;
  await ticket.save();

  await recordAudit(actor, { action: 'TICKET_STATUS_CHANGED', targetType: 'SUPPORT_TICKET', targetId: ticketId, metadata: { from: previousStatus, to: status } });
  return getTicket(ticketId);
}

// POST /admin/support/tickets/:ticketId/messages — reply as staff. An OPEN ticket becomes IN_PROGRESS.
export async function replyToTicket(actor, ticketId, { body }) {
  const ticket = await SupportTicket.findById(ticketId);
  if (!ticket) throw ApiError.notFound();
  if (ticket.status === 'CLOSED') throw ApiError.conflict('This ticket is closed. Reopen it before replying.');

  ticket.messages.push({ author: 'STAFF', authorId: actor.id, body });
  if (ticket.status === 'OPEN') ticket.status = 'IN_PROGRESS';
  await ticket.save();

  await notifyUser(ticket.userId, {
    type: 'SYSTEM',
    title: 'Support replied',
    body: 'Our support team replied to your request.',
    data: { ticketId },
  });
  await recordAudit(actor, { action: 'TICKET_REPLIED', targetType: 'SUPPORT_TICKET', targetId: ticketId, metadata: { status: ticket.status } });
  return getTicket(ticketId);
}
