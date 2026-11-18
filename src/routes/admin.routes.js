// Routes for /api/v1/admin. Every route needs a signed-in staff member; module actions are
// enforced with requirePermission against the caller's AdminRole matrix (system or custom).

import { Router } from 'express';
import * as adminController from '../controllers/admin.controller.js';
import { requireAnyPermission, requireAuth, requirePermission, requireStaff } from '../middlewares/auth.middleware.js';
import { byUser, createRateLimiter, MINUTE } from '../utils/rateLimit.js';

const router = Router();

const adminLimit = createRateLimiter({ windowMs: MINUTE, max: 300, keyFrom: byUser });
const can = (module, action) => requirePermission(module, action);
const canStaffOrRolesView = requireAnyPermission(['STAFF', 'VIEW'], ['ROLES', 'VIEW']);

router.use(requireAuth, requireStaff, adminLimit);

// ---- Session and dashboard ----

router.get('/me', adminController.getMe);
router.get('/dashboard', can('DASHBOARD', 'VIEW'), adminController.getDashboard);

// ---- Users ----

router.get('/login-activity', can('AUDIT_LOGS', 'VIEW'), adminController.listLoginActivity);
router.get('/users/stats', can('USERS', 'VIEW'), adminController.getUserStats);
router.get('/users', can('USERS', 'VIEW'), adminController.listUsers);
router.post('/users', can('USERS', 'CREATE'), adminController.createUser);
router.get('/users/:userId', can('USERS', 'VIEW'), adminController.getUser);
router.get('/users/:userId/reports', can('USERS', 'VIEW'), adminController.getUserReports);
router.get('/users/:userId/matches', can('USERS', 'VIEW'), adminController.getUserMatches);
router.get('/users/:userId/sessions', can('USERS', 'VIEW'), adminController.getUserSessions);
router.get('/users/:userId/activity', can('USERS', 'VIEW'), adminController.getUserActivity);
router.get('/users/:userId/export', can('USERS', 'DELETE'), adminController.exportUser);
router.post('/users/:userId/deletion', can('USERS', 'DELETE'), adminController.scheduleUserDeletion);
router.patch('/users/:userId/status', can('USERS', 'EDIT'), adminController.changeUserStatus);

// ---- Reports ----

router.get('/reports', can('REPORTS', 'VIEW'), adminController.listReports);
router.get('/reports/:reportId', can('REPORTS', 'VIEW'), adminController.getReport);
router.patch('/reports/:reportId', can('REPORTS', 'EDIT'), adminController.updateReport);

// ---- Verifications ----

router.get('/verifications', can('VERIFICATIONS', 'VIEW'), adminController.listVerifications);
router.get('/verifications/:verificationId', can('VERIFICATIONS', 'VIEW'), adminController.getVerification);
router.patch('/verifications/:verificationId', can('VERIFICATIONS', 'EDIT'), adminController.reviewVerification);

// ---- Subscriptions ----

router.get('/subscriptions/stats', can('SUBSCRIPTIONS', 'VIEW'), adminController.getSubscriptionStats);
router.get('/subscriptions/analytics', can('SUBSCRIPTIONS', 'VIEW'), adminController.getSubscriptionAnalytics);
router.get('/subscriptions/plans', can('SUBSCRIPTIONS', 'VIEW'), adminController.listSubscriptionPlans);
router.patch('/subscriptions/plans/:productId', can('SUBSCRIPTIONS', 'EDIT'), adminController.updateSubscriptionPlan);
router.get('/subscriptions', can('SUBSCRIPTIONS', 'VIEW'), adminController.listSubscriptions);
router.get('/subscriptions/:userId', can('SUBSCRIPTIONS', 'VIEW'), adminController.getSubscription);

// ---- Support ----

router.get('/support/tickets', can('SUPPORT', 'VIEW'), adminController.listTickets);
router.get('/support/tickets/:ticketId', can('SUPPORT', 'VIEW'), adminController.getTicket);
router.patch('/support/tickets/:ticketId', can('SUPPORT', 'EDIT'), adminController.updateTicket);
router.post('/support/tickets/:ticketId/messages', can('SUPPORT', 'EDIT'), adminController.replyToTicket);

// ---- Notifications ----

router.get('/notifications', can('NOTIFICATIONS', 'VIEW'), adminController.listCampaigns);
router.post('/notifications', can('NOTIFICATIONS', 'CREATE'), adminController.sendCampaign);

// ---- Audit logs and settings ----

router.get('/audit-logs', can('AUDIT_LOGS', 'VIEW'), adminController.listAuditLogs);
router.get('/audit-logs/:auditLogId', can('AUDIT_LOGS', 'VIEW'), adminController.getAuditLog);
router.get('/settings', can('SETTINGS', 'VIEW'), adminController.getSettings);
router.patch('/settings', can('SETTINGS', 'EDIT'), adminController.updateSettings);

// ---- Matches ----

router.get('/matches/stats', can('MATCHES', 'VIEW'), adminController.getMatchStats);
router.get('/matches/analytics', can('MATCHES', 'VIEW'), adminController.getMatchAnalytics);
router.get('/matches/suspicious', can('MATCHES', 'VIEW'), adminController.listSuspiciousMatches);
router.get('/matches/reported', can('MATCHES', 'VIEW'), adminController.listReportedMatches);
router.get('/matches/config', can('MATCHES', 'VIEW'), adminController.getMatchConfig);
router.patch('/matches/config', can('MATCHES', 'EDIT'), adminController.updateMatchConfig);
router.get('/matches/:matchId', can('MATCHES', 'VIEW'), adminController.getMatch);
router.post('/matches/:matchId/end', can('MATCHES', 'EDIT'), adminController.endMatch);
router.get('/matches', can('MATCHES', 'VIEW'), adminController.listMatches);

// ---- Swipes ----

router.get('/swipes/stats', can('SWIPES', 'VIEW'), adminController.getSwipeStats);
router.get('/swipes/analytics', can('SWIPES', 'VIEW'), adminController.getSwipeAnalytics);
router.get('/swipes/abuse', can('SWIPES', 'VIEW'), adminController.listSwipeAbuse);
router.get('/swipes/entitlements', can('SWIPES', 'VIEW'), adminController.getSwipeEntitlements);
router.patch('/swipes/entitlements', can('SWIPES', 'EDIT'), adminController.updateSwipeEntitlements);
router.get('/swipes/members/:userId/report', can('SWIPES', 'VIEW'), adminController.getMemberSwipeReport);
router.get('/swipes', can('SWIPES', 'VIEW'), adminController.listSwipes);

// ---- Blocks ----

router.get('/blocks/stats', can('BLOCKS', 'VIEW'), adminController.getBlockStats);
router.get('/blocks/analytics', can('BLOCKS', 'VIEW'), adminController.getBlockAnalytics);
router.get('/blocks/velocity', can('BLOCKS', 'VIEW'), adminController.listBlockVelocity);
router.get('/blocks/members/:userId/report', can('BLOCKS', 'VIEW'), adminController.getMemberBlockReport);
router.get('/blocks/:blockId', can('BLOCKS', 'VIEW'), adminController.getBlock);
router.get('/blocks', can('BLOCKS', 'VIEW'), adminController.listBlocks);

// ---- Staff & roles ----

router.get('/staff/stats', can('STAFF', 'VIEW'), adminController.getStaffStats);
router.get('/staff', can('STAFF', 'VIEW'), adminController.listStaff);
router.post('/staff', can('STAFF', 'CREATE'), adminController.createStaff);
router.get('/staff/:userId', can('STAFF', 'VIEW'), adminController.getStaff);
router.get('/staff/:userId/sessions', can('STAFF', 'VIEW'), adminController.listStaffSessions);
router.get('/staff/:userId/activity', can('STAFF', 'VIEW'), adminController.listStaffActivity);
router.patch('/staff/:userId/role', can('STAFF', 'EDIT'), adminController.updateStaffRole);
router.patch('/staff/:userId/status', can('STAFF', 'EDIT'), adminController.updateStaffStatus);
router.post('/staff/:userId/force-logout', can('STAFF', 'EDIT'), adminController.forceStaffLogout);

router.post('/me/2fa/setup', adminController.beginTwoFactorSetup);
router.post('/me/2fa/confirm', adminController.confirmTwoFactorSetup);
router.post('/me/2fa/disable', adminController.disableTwoFactor);

router.get('/roles/stats', canStaffOrRolesView, adminController.getRoleStats);
router.get('/roles/catalog', canStaffOrRolesView, adminController.getPermissionCatalog);
router.get('/roles', canStaffOrRolesView, adminController.listRoles);
router.post('/roles', can('ROLES', 'CREATE'), adminController.createRole);
router.get('/roles/:roleId', canStaffOrRolesView, adminController.getRole);
router.patch('/roles/:roleId', can('ROLES', 'EDIT'), adminController.updateRole);
router.put('/roles/:roleId/permissions', can('ROLES', 'EDIT'), adminController.updateRolePermissions);
router.delete('/roles/:roleId', can('ROLES', 'DELETE'), adminController.deleteRole);

// ---- Profiles ----

router.get('/profiles/stats', can('PROFILES', 'VIEW'), adminController.getProfileStats);
router.get('/profiles/photo-queue', can('PROFILES', 'VIEW'), adminController.listPhotoQueue);
router.get('/profiles', can('PROFILES', 'VIEW'), adminController.listProfiles);
router.get('/profiles/:userId', can('PROFILES', 'VIEW'), adminController.getProfile);
router.get('/profiles/:userId/history', can('PROFILES', 'VIEW'), adminController.getProfileHistory);
router.patch('/profiles/:userId', can('PROFILES', 'EDIT'), adminController.updateProfile);
router.patch('/profiles/:userId/account', can('PROFILES', 'EDIT'), adminController.updateProfileAccount);
router.patch('/profiles/:userId/visibility', can('PROFILES', 'EDIT'), adminController.updateProfileVisibility);
router.patch('/profiles/:userId/boost', can('PROFILES', 'EDIT'), adminController.updateProfileBoost);
router.patch('/profiles/:userId/privacy', can('PROFILES', 'EDIT'), adminController.updateProfilePrivacy);
router.patch('/profiles/:userId/photos/:photoId/moderation', can('PROFILES', 'EDIT'), adminController.moderateProfilePhoto);
router.delete('/profiles/:userId/photos/:photoId', can('PROFILES', 'DELETE'), adminController.removeProfilePhoto);

// ---- Messaging / analytics / monitoring ----

router.get('/messaging/stats', can('MESSAGING', 'VIEW'), adminController.getMessagingStats);
router.get('/messaging/conversations', can('MESSAGING', 'VIEW'), adminController.listConversations);
router.get('/analytics', can('ANALYTICS', 'VIEW'), adminController.getAnalytics);
router.get('/monitoring', can('MONITORING', 'VIEW'), adminController.getMonitoring);

// ---- CMS ----

router.get('/cms', can('CMS', 'VIEW'), adminController.listCms);
router.get('/cms/:id', can('CMS', 'VIEW'), adminController.getCms);
router.post('/cms', can('CMS', 'CREATE'), adminController.createCms);
router.patch('/cms/:id', can('CMS', 'EDIT'), adminController.updateCms);

// ---- Coupons ----

router.get('/coupons/stats', can('COUPONS', 'VIEW'), adminController.getCouponStats);
router.get('/coupons', can('COUPONS', 'VIEW'), adminController.listCoupons);
router.post('/coupons', can('COUPONS', 'CREATE'), adminController.createCoupon);
router.patch('/coupons/:id', can('COUPONS', 'EDIT'), adminController.updateCoupon);

// ---- Referrals ----

router.get('/referrals/stats', can('REFERRALS', 'VIEW'), adminController.getReferralStats);
router.get('/referrals', can('REFERRALS', 'VIEW'), adminController.listReferrals);
router.post('/referrals', can('REFERRALS', 'CREATE'), adminController.createReferral);
router.patch('/referrals/:id', can('REFERRALS', 'EDIT'), adminController.updateReferral);

// ---- Fraud ----

router.get('/fraud/status', can('FRAUD', 'VIEW'), adminController.getFraudStatus);
router.get('/fraud/signals', can('FRAUD', 'VIEW'), adminController.listFraudSignals);
router.post('/fraud/scan/:userId', can('FRAUD', 'CREATE'), adminController.scanFraudUser);
router.patch('/fraud/signals/:id', can('FRAUD', 'EDIT'), adminController.updateFraudSignal);

// ---- Experiments ----

router.get('/experiments', can('EXPERIMENTS', 'VIEW'), adminController.listExperiments);
router.get('/experiments/:id', can('EXPERIMENTS', 'VIEW'), adminController.getExperiment);
router.post('/experiments', can('EXPERIMENTS', 'CREATE'), adminController.createExperiment);
router.patch('/experiments/:id', can('EXPERIMENTS', 'EDIT'), adminController.updateExperiment);

// ---- Calls / payments ----

router.get('/calls/status', can('CALLS', 'VIEW'), adminController.getCallsStatus);
router.get('/calls/stats', can('CALLS', 'VIEW'), adminController.getCallsStats);
router.get('/calls', can('CALLS', 'VIEW'), adminController.listCalls);
router.get('/calls/:callId', can('CALLS', 'VIEW'), adminController.getCall);
router.get('/payments/status', can('PAYMENTS', 'VIEW'), adminController.getPaymentsStatus);
router.get('/payments/stats', can('PAYMENTS', 'VIEW'), adminController.getPaymentsStats);
router.get('/payments', can('PAYMENTS', 'VIEW'), adminController.listPayments);
router.get('/payments/:paymentId', can('PAYMENTS', 'VIEW'), adminController.getPayment);

// ---- Virtual store (uses PAYMENTS module — no separate STORE catalog entry) ----

router.get('/store/items', can('PAYMENTS', 'VIEW'), adminController.listStoreItems);
router.post('/store/items', can('PAYMENTS', 'CREATE'), adminController.createStoreItem);
router.patch('/store/items/:itemId', can('PAYMENTS', 'EDIT'), adminController.updateStoreItem);
router.get('/store/purchases', can('PAYMENTS', 'VIEW'), adminController.listStorePurchases);
router.get('/store/wallets/:userId', can('PAYMENTS', 'VIEW'), adminController.getStoreWallet);
router.post('/store/wallets/:userId/adjust', can('PAYMENTS', 'EDIT'), adminController.adjustStoreWallet);

export default router;
