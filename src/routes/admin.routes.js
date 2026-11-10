// Routes for /api/v1/admin. Every route needs a signed-in MODERATOR or ADMIN (role read from
// MongoDB, not from the token); some routes are ADMIN only.

import { Router } from 'express';
import * as adminController from '../controllers/admin.controller.js';
import { requireAuth, requireMinRank, requirePermission, requireStaff } from '../middlewares/auth.middleware.js';
import { byUser, createRateLimiter, MINUTE } from '../utils/rateLimit.js';

const router = Router();

const adminLimit = createRateLimiter({ windowMs: MINUTE, max: 300, keyFrom: byUser });
const adminOnly = requireMinRank('ADMIN');

router.use(requireAuth, requireStaff, adminLimit);

// ---- Session and dashboard ----

// GET /api/v1/admin/me — the signed-in staff member (restores the admin session after a reload).
router.get('/me', adminController.getMe);

// GET /api/v1/admin/dashboard — dashboard stats.
router.get('/dashboard', adminController.getDashboard);

// ---- Users ----

// GET /api/v1/admin/login-activity — cross-user login history (AUDIT_LOGS.VIEW).
router.get('/login-activity', requirePermission('AUDIT_LOGS', 'VIEW'), adminController.listLoginActivity);

// GET /api/v1/admin/users/stats — KPI counts for the users page.
router.get('/users/stats', adminController.getUserStats);

// GET /api/v1/admin/users — list / search users.
router.get('/users', adminController.listUsers);

// POST /api/v1/admin/users — create a member by phone with profile fields.
router.post('/users', adminController.createUser);

// GET /api/v1/admin/users/:userId — one user's details.
router.get('/users/:userId', adminController.getUser);

// GET /api/v1/admin/users/:userId/reports — reports filed by or against this user.
router.get('/users/:userId/reports', adminController.getUserReports);

// GET /api/v1/admin/users/:userId/matches — this user's matches.
router.get('/users/:userId/matches', adminController.getUserMatches);

// GET /api/v1/admin/users/:userId/sessions — login / device history.
router.get('/users/:userId/sessions', adminController.getUserSessions);

// GET /api/v1/admin/users/:userId/activity — registration, logins and staff action timeline.
router.get('/users/:userId/activity', adminController.getUserActivity);

// GET /api/v1/admin/users/:userId/export — downloadable account data package (ADMIN).
router.get('/users/:userId/export', adminOnly, adminController.exportUser);

// POST /api/v1/admin/users/:userId/deletion — schedule account deletion (ADMIN).
router.post('/users/:userId/deletion', adminOnly, adminController.scheduleUserDeletion);

// PATCH /api/v1/admin/users/:userId/status — change account status (e.g. suspend / ban / reactivate).
router.patch('/users/:userId/status', adminController.changeUserStatus);

// ---- Reports ----

// GET /api/v1/admin/reports — moderation report queue.
router.get('/reports', adminController.listReports);

// GET /api/v1/admin/reports/:reportId — one report.
router.get('/reports/:reportId', adminController.getReport);

// PATCH /api/v1/admin/reports/:reportId — update a report (status, resolution).
router.patch('/reports/:reportId', adminController.updateReport);

// ---- Verifications ----

// GET /api/v1/admin/verifications — selfie verification queue.
router.get('/verifications', adminController.listVerifications);

// GET /api/v1/admin/verifications/:verificationId — one verification submission.
router.get('/verifications/:verificationId', adminController.getVerification);

// PATCH /api/v1/admin/verifications/:verificationId — approve or reject a verification.
router.patch('/verifications/:verificationId', adminController.reviewVerification);

// ---- Subscriptions (ADMIN only) ----

// GET /api/v1/admin/subscriptions — list member subscriptions (ADMIN only).
router.get('/subscriptions', adminOnly, adminController.listSubscriptions);

// GET /api/v1/admin/subscriptions/:userId — one member's subscription (ADMIN only).
router.get('/subscriptions/:userId', adminOnly, adminController.getSubscription);

// ---- Support ----

// GET /api/v1/admin/support/tickets — list support tickets.
router.get('/support/tickets', adminController.listTickets);

// GET /api/v1/admin/support/tickets/:ticketId — one support ticket with its messages.
router.get('/support/tickets/:ticketId', adminController.getTicket);

// PATCH /api/v1/admin/support/tickets/:ticketId — update a ticket (status, assignee, etc.).
router.patch('/support/tickets/:ticketId', adminController.updateTicket);

// POST /api/v1/admin/support/tickets/:ticketId/messages — reply to a ticket as staff.
router.post('/support/tickets/:ticketId/messages', adminController.replyToTicket);

// ---- Notifications ----

// GET /api/v1/admin/notifications — list notification campaigns.
router.get('/notifications', adminController.listCampaigns);

// POST /api/v1/admin/notifications — send a notification campaign (ADMIN only).
router.post('/notifications', adminOnly, adminController.sendCampaign);

// ---- Audit logs and settings (ADMIN only) ----

// GET /api/v1/admin/audit-logs — list staff audit log entries (ADMIN only).
router.get('/audit-logs', adminOnly, adminController.listAuditLogs);

// GET /api/v1/admin/audit-logs/:auditLogId — one audit log entry (ADMIN only).
router.get('/audit-logs/:auditLogId', adminOnly, adminController.getAuditLog);

// GET /api/v1/admin/settings — editable app settings plus read-only system info (ADMIN only).
router.get('/settings', adminOnly, adminController.getSettings);

// PATCH /api/v1/admin/settings — update app settings (ADMIN only).
router.patch('/settings', adminOnly, adminController.updateSettings);

// ---- Matches ----

router.get('/matches/stats', adminController.getMatchStats);
router.get('/matches/analytics', adminController.getMatchAnalytics);
router.get('/matches/suspicious', adminOnly, adminController.listSuspiciousMatches);
router.get('/matches/reported', adminController.listReportedMatches);
router.get('/matches/config', adminOnly, adminController.getMatchConfig);
router.patch('/matches/config', adminOnly, adminController.updateMatchConfig);
router.get('/matches/:matchId', adminController.getMatch);
router.post('/matches/:matchId/end', adminOnly, adminController.endMatch);
router.get('/matches', adminController.listMatches);

// ---- Swipes ----

router.get('/swipes/stats', adminController.getSwipeStats);
router.get('/swipes/analytics', adminController.getSwipeAnalytics);
router.get('/swipes/abuse', adminOnly, adminController.listSwipeAbuse);
router.get('/swipes/entitlements', adminOnly, adminController.getSwipeEntitlements);
router.patch('/swipes/entitlements', adminOnly, adminController.updateSwipeEntitlements);
router.get('/swipes/members/:userId/report', adminOnly, adminController.getMemberSwipeReport);
router.get('/swipes', adminOnly, adminController.listSwipes);

// ---- Blocks ----

router.get('/blocks/stats', adminController.getBlockStats);
router.get('/blocks/analytics', adminController.getBlockAnalytics);
router.get('/blocks/velocity', adminOnly, adminController.listBlockVelocity);
router.get('/blocks/members/:userId/report', adminOnly, adminController.getMemberBlockReport);
router.get('/blocks/:blockId', adminController.getBlock);
router.get('/blocks', adminController.listBlocks);

// ---- Staff & roles (ADMIN tier) ----

router.get('/staff/stats', adminOnly, adminController.getStaffStats);
router.get('/staff', adminOnly, adminController.listStaff);
router.post('/staff', adminOnly, adminController.createStaff);
router.get('/staff/:userId', adminOnly, adminController.getStaff);
router.get('/staff/:userId/sessions', adminOnly, adminController.listStaffSessions);
router.get('/staff/:userId/activity', adminOnly, adminController.listStaffActivity);
router.patch('/staff/:userId/role', adminOnly, adminController.updateStaffRole);
router.patch('/staff/:userId/status', adminOnly, adminController.updateStaffStatus);
router.post('/staff/:userId/force-logout', adminOnly, adminController.forceStaffLogout);

router.post('/me/2fa/setup', adminController.beginTwoFactorSetup);
router.post('/me/2fa/confirm', adminController.confirmTwoFactorSetup);
router.post('/me/2fa/disable', adminController.disableTwoFactor);

router.get('/roles/stats', adminOnly, adminController.getRoleStats);
router.get('/roles/catalog', adminOnly, adminController.getPermissionCatalog);
router.get('/roles', adminOnly, adminController.listRoles);
router.post('/roles', adminOnly, adminController.createRole);
router.get('/roles/:roleId', adminOnly, adminController.getRole);
router.patch('/roles/:roleId', adminOnly, adminController.updateRole);
router.put('/roles/:roleId/permissions', adminOnly, adminController.updateRolePermissions);
router.delete('/roles/:roleId', adminOnly, adminController.deleteRole);

// ---- Profiles ----

router.get('/profiles/stats', adminController.getProfileStats);
router.get('/profiles/photo-queue', adminController.listPhotoQueue);
router.get('/profiles', adminController.listProfiles);
router.get('/profiles/:userId', adminController.getProfile);
router.get('/profiles/:userId/history', adminController.getProfileHistory);
router.patch('/profiles/:userId', adminController.updateProfile);
router.patch('/profiles/:userId/account', adminOnly, adminController.updateProfileAccount);
router.patch('/profiles/:userId/visibility', adminController.updateProfileVisibility);
router.patch('/profiles/:userId/boost', adminController.updateProfileBoost);
router.patch('/profiles/:userId/privacy', adminController.updateProfilePrivacy);
router.patch('/profiles/:userId/photos/:photoId/moderation', adminController.moderateProfilePhoto);
router.delete('/profiles/:userId/photos/:photoId', adminController.removeProfilePhoto);

// ---- Messaging / analytics / monitoring ----

router.get('/messaging/stats', adminController.getMessagingStats);
router.get('/messaging/conversations', adminController.listConversations);
router.get('/analytics', adminController.getAnalytics);
router.get('/monitoring', adminOnly, adminController.getMonitoring);

// ---- CMS (staff read, ADMIN write) ----

router.get('/cms', adminController.listCms);
router.get('/cms/:id', adminController.getCms);
router.post('/cms', adminOnly, adminController.createCms);
router.patch('/cms/:id', adminOnly, adminController.updateCms);

// ---- Coupons (ADMIN only) ----

router.get('/coupons/stats', adminOnly, adminController.getCouponStats);
router.get('/coupons', adminOnly, adminController.listCoupons);
router.post('/coupons', adminOnly, adminController.createCoupon);
router.patch('/coupons/:id', adminOnly, adminController.updateCoupon);

// ---- Referrals (ADMIN only) ----

router.get('/referrals/stats', adminOnly, adminController.getReferralStats);
router.get('/referrals', adminOnly, adminController.listReferrals);
router.post('/referrals', adminOnly, adminController.createReferral);
router.patch('/referrals/:id', adminOnly, adminController.updateReferral);

// ---- Fraud ----

router.get('/fraud/status', adminController.getFraudStatus);
router.get('/fraud/signals', adminController.listFraudSignals);
router.post('/fraud/scan/:userId', adminController.scanFraudUser);
router.patch('/fraud/signals/:id', adminController.updateFraudSignal);

// ---- Experiments (ADMIN only) ----

router.get('/experiments', adminOnly, adminController.listExperiments);
router.get('/experiments/:id', adminOnly, adminController.getExperiment);
router.post('/experiments', adminOnly, adminController.createExperiment);
router.patch('/experiments/:id', adminOnly, adminController.updateExperiment);

// ---- Calls / payments (ADMIN only) ----

router.get('/calls/status', adminOnly, adminController.getCallsStatus);
router.get('/calls/stats', adminOnly, adminController.getCallsStats);
router.get('/calls', adminOnly, adminController.listCalls);
router.get('/calls/:callId', adminOnly, adminController.getCall);
router.get('/payments/status', adminOnly, adminController.getPaymentsStatus);

export default router;
