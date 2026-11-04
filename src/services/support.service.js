// Member support: FAQs and tickets. Staff replies are shown without the staff member's identity.

import { FAQS } from '../config/catalog.js';
import { SupportTicket } from '../models/SupportTicket.js';
import { ApiError } from '../utils/ApiError.js';

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
    createdAt: ticket.createdAt,
    messages: ticket.messages.map((message) => ({
      id: message._id,
      author: message.author,
      body: message.body,
      createdAt: message.createdAt,
    })),
  };
}

// Opens a ticket with the member's first message.
export async function createTicket(userId, { category, subject, message }) {
  const ticket = await SupportTicket.create({
    userId,
    category,
    subject,
    messages: [{ author: 'USER', authorId: userId, body: message }],
  });
  return presentTicketForMember(ticket);
}

// Returns one of the member's own tickets. Other members' tickets are 404.
export async function getTicket(userId, ticketId) {
  const ticket = await SupportTicket.findOne({ _id: ticketId, userId }).lean();
  if (!ticket) throw ApiError.notFound();
  return presentTicketForMember(ticket);
}
