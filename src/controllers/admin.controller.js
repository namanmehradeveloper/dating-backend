// HTTP handlers for the admin panel (/api/v1/admin). Each handler validates input and calls one
// service; role checks live in admin.routes.js and every write is audited by its service.

import { ApiResponse } from '../utils/ApiResponse.js';
import { parsePagination } from '../utils/pagination.js';
import * as adminAnalytics from '../services/admin/adminAnalytics.service.js';
import * as adminBlocks from '../services/admin/adminBlocks.service.js';
import * as adminCalls from '../services/admin/adminCalls.service.js';
import * as adminCms from '../services/admin/adminCms.service.js';
import * as adminCoupons from '../services/admin/adminCoupons.service.js';
import * as adminDashboard from '../services/admin/adminDashboard.service.js';
import * as adminExperiments from '../services/admin/adminExperiments.service.js';
import * as adminFraud from '../services/admin/adminFraud.service.js';
import * as adminMatches from '../services/admin/adminMatches.service.js';
import * as adminMessaging from '../services/admin/adminMessaging.service.js';
import * as adminMonitoring from '../services/admin/adminMonitoring.service.js';
import * as adminNotifications from '../services/admin/adminNotifications.service.js';
import * as adminPayments from '../services/admin/adminPayments.service.js';
import * as adminProfiles from '../services/admin/adminProfiles.service.js';
import * as adminReferrals from '../services/admin/adminReferrals.service.js';
import * as adminReports from '../services/admin/adminReports.service.js';
import * as adminRoles from '../services/admin/adminRoles.service.js';
import * as adminStaff from '../services/admin/adminStaff.service.js';
import * as adminSubscriptions from '../services/admin/adminSubscriptions.service.js';
import * as adminSupport from '../services/admin/adminSupport.service.js';
import * as adminSwipes from '../services/admin/adminSwipes.service.js';
import * as adminUsers from '../services/admin/adminUsers.service.js';
import * as adminVerifications from '../services/admin/adminVerifications.service.js';
import * as auditService from '../services/audit.service.js';
import * as settingsService from '../services/settings.service.js';
import * as validators from '../validators/admin.validator.js';

// ---- Session and dashboard ----

// GET /admin/me — the signed-in staff member (restores the admin session after a reload).
export async function getMe(req, res) {
  return ApiResponse.ok(res, await adminUsers.getStaffSession(req.user.id));
}

// GET /admin/dashboard?days=7|30|90 or ?from=&to=
export async function getDashboard(req, res) {
  const range = validators.validateDashboardQuery(req.query);
  return ApiResponse.ok(res, await adminDashboard.getDashboard(range));
}

// ---- Users ----

// GET /admin/users/stats
export async function getUserStats(req, res) {
  return ApiResponse.ok(res, await adminUsers.getUserStats());
}

// GET /admin/users
export async function listUsers(req, res) {
  const filters = validators.validateUserListQuery(req.query);
  return ApiResponse.ok(res, await adminUsers.listUsers(filters, parsePagination(req.query), req.user.role));
}

// POST /admin/users — create a member by phone with profile fields.
export async function createUser(req, res) {
  const input = validators.validateUserCreate(req.body);
  return ApiResponse.created(res, await adminUsers.createUser(req.user, input, req.user.role));
}

// GET /admin/users/:userId
export async function getUser(req, res) {
  return ApiResponse.ok(res, await adminUsers.getUserDetail(req.params.userId, req.user.role));
}

// GET /admin/users/:userId/reports
export async function getUserReports(req, res) {
  const options = validators.validateUserReportsQuery(req.query);
  return ApiResponse.ok(res, await adminUsers.listUserReports(req.params.userId, options, parsePagination(req.query)));
}

// GET /admin/users/:userId/matches
export async function getUserMatches(req, res) {
  return ApiResponse.ok(res, await adminUsers.listUserMatches(req.params.userId, parsePagination(req.query)));
}

// GET /admin/users/:userId/sessions
export async function getUserSessions(req, res) {
  return ApiResponse.ok(res, await adminUsers.listUserSessions(req.params.userId, parsePagination(req.query)));
}

// GET /admin/users/:userId/activity
export async function getUserActivity(req, res) {
  return ApiResponse.ok(res, await adminUsers.listUserActivity(req.params.userId, parsePagination(req.query)));
}

// GET /admin/users/:userId/export — ADMIN only (route also gated).
export async function exportUser(req, res) {
  return ApiResponse.ok(res, await adminUsers.exportUserData(req.user, req.params.userId));
}

// POST /admin/users/:userId/deletion — ADMIN only (route also gated).
export async function scheduleUserDeletion(req, res) {
  const body = validators.validateUserDeletion(req.body);
  return ApiResponse.accepted(res, await adminUsers.scheduleUserDeletion(req.user, req.params.userId, body));
}

// PATCH /admin/users/:userId/status
export async function changeUserStatus(req, res) {
  const change = validators.validateStatusChange(req.body);
  return ApiResponse.ok(res, await adminUsers.changeUserStatus(req.user, req.params.userId, change));
}

// ---- Reports ----

// GET /admin/reports
export async function listReports(req, res) {
  const filters = validators.validateReportListQuery(req.query);
  return ApiResponse.ok(res, await adminReports.listReports(filters, parsePagination(req.query)));
}

// GET /admin/reports/:reportId
export async function getReport(req, res) {
  return ApiResponse.ok(res, await adminReports.getReport(req.params.reportId));
}

// PATCH /admin/reports/:reportId
export async function updateReport(req, res) {
  const update = validators.validateReportUpdate(req.body);
  return ApiResponse.ok(res, await adminReports.updateReport(req.user, req.params.reportId, update));
}

// ---- Verifications ----

// GET /admin/verifications
export async function listVerifications(req, res) {
  const filters = validators.validateVerificationListQuery(req.query);
  return ApiResponse.ok(res, await adminVerifications.listVerifications(filters, parsePagination(req.query)));
}

// GET /admin/verifications/:verificationId
export async function getVerification(req, res) {
  return ApiResponse.ok(res, await adminVerifications.getVerification(req.params.verificationId));
}

// PATCH /admin/verifications/:verificationId
export async function reviewVerification(req, res) {
  const decision = validators.validateVerificationReview(req.body);
  return ApiResponse.ok(res, await adminVerifications.reviewVerification(req.user, req.params.verificationId, decision));
}

// ---- Subscriptions (ADMIN) ----

// GET /admin/subscriptions
export async function listSubscriptions(req, res) {
  const filters = validators.validateSubscriptionListQuery(req.query);
  return ApiResponse.ok(res, await adminSubscriptions.listSubscriptions(filters, parsePagination(req.query)));
}

// GET /admin/subscriptions/:userId
export async function getSubscription(req, res) {
  return ApiResponse.ok(res, await adminSubscriptions.getSubscription(req.params.userId));
}

// ---- Support ----

// GET /admin/support/tickets
export async function listTickets(req, res) {
  const filters = validators.validateTicketListQuery(req.query);
  return ApiResponse.ok(res, await adminSupport.listTickets(filters, parsePagination(req.query)));
}

// GET /admin/support/tickets/:ticketId
export async function getTicket(req, res) {
  return ApiResponse.ok(res, await adminSupport.getTicket(req.params.ticketId));
}

// PATCH /admin/support/tickets/:ticketId
export async function updateTicket(req, res) {
  const update = validators.validateTicketUpdate(req.body);
  return ApiResponse.ok(res, await adminSupport.updateTicketStatus(req.user, req.params.ticketId, update));
}

// POST /admin/support/tickets/:ticketId/messages
export async function replyToTicket(req, res) {
  const reply = validators.validateTicketReply(req.body);
  return ApiResponse.created(res, await adminSupport.replyToTicket(req.user, req.params.ticketId, reply));
}

// ---- Notifications ----

// GET /admin/notifications
export async function listCampaigns(req, res) {
  const filters = validators.validateCampaignListQuery(req.query);
  return ApiResponse.ok(res, await adminNotifications.listCampaigns(filters, parsePagination(req.query)));
}

// POST /admin/notifications (ADMIN)
export async function sendCampaign(req, res) {
  const campaign = validators.validateCampaign(req.body);
  return ApiResponse.created(res, await adminNotifications.sendCampaign(req.user, campaign));
}

// ---- Audit logs and settings (ADMIN) ----

// GET /admin/audit-logs
export async function listAuditLogs(req, res) {
  const filters = validators.validateAuditQuery(req.query);
  return ApiResponse.ok(res, await auditService.listAuditLogs(filters, parsePagination(req.query)));
}

// GET /admin/audit-logs/:auditLogId
export async function getAuditLog(req, res) {
  return ApiResponse.ok(res, await auditService.getAuditLog(req.params.auditLogId));
}

// Builds the settings page data: editable values plus read-only, non-secret system facts.
async function loadSettingsPage() {
  return { settings: await settingsService.getEditableSettings(), system: settingsService.getSystemInfo() };
}

// GET /admin/settings
export async function getSettings(req, res) {
  return ApiResponse.ok(res, await loadSettingsPage());
}

// PATCH /admin/settings
export async function updateSettings(req, res) {
  const changes = validators.validateSettingsUpdate(req.body);
  const previous = await settingsService.saveSettings(changes, req.user.id);
  const diff = Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, { from: previous[key], to: value }]));
  await auditService.recordAudit(req.user, { action: 'SETTINGS_UPDATED', targetType: 'SETTINGS', targetId: 'app', metadata: { changes: diff } });
  return ApiResponse.ok(res, await loadSettingsPage());
}

// ---- Matches ----

export async function getMatchStats(req, res) {
  const { days } = validators.validateDaysQuery(req.query);
  return ApiResponse.ok(res, await adminMatches.getMatchStats({ days }));
}

export async function getMatchAnalytics(req, res) {
  const { days } = validators.validateDaysQuery(req.query);
  return ApiResponse.ok(res, await adminMatches.getMatchAnalytics({ days }));
}

export async function listSuspiciousMatches(req, res) {
  return ApiResponse.ok(res, await adminMatches.listSuspiciousMatches());
}

export async function listReportedMatches(req, res) {
  return ApiResponse.ok(res, await adminMatches.listReportedMatches(parsePagination(req.query)));
}

export async function getMatchConfig(req, res) {
  return ApiResponse.ok(res, await adminMatches.getMatchConfig());
}

export async function updateMatchConfig(req, res) {
  const changes = validators.validateMatchConfigUpdate(req.body);
  return ApiResponse.ok(res, await adminMatches.updateMatchConfig(req.user, changes));
}

export async function getMatch(req, res) {
  return ApiResponse.ok(res, await adminMatches.getMatchDetail(req.params.matchId));
}

export async function endMatch(req, res) {
  const { reason } = validators.validateMatchEndBody(req.body ?? {});
  return ApiResponse.ok(res, await adminMatches.endMatchByAdmin(req.user, req.params.matchId, reason));
}

export async function listMatches(req, res) {
  const filters = validators.validateMatchListQuery(req.query);
  return ApiResponse.ok(res, await adminMatches.listMatches(filters, parsePagination(req.query)));
}

// ---- Swipes ----

export async function getSwipeStats(req, res) {
  const { days } = validators.validateDaysQuery(req.query);
  return ApiResponse.ok(res, await adminSwipes.getSwipeStats({ days }));
}

export async function getSwipeAnalytics(req, res) {
  const { days } = validators.validateDaysQuery(req.query);
  return ApiResponse.ok(res, await adminSwipes.getSwipeAnalytics({ days }));
}

export async function listSwipeAbuse(req, res) {
  return ApiResponse.ok(res, await adminSwipes.listSwipeAbuse());
}

export async function getSwipeEntitlements(req, res) {
  return ApiResponse.ok(res, await adminSwipes.getSwipeEntitlements());
}

export async function updateSwipeEntitlements(req, res) {
  const changes = validators.validateSwipeEntitlementsUpdate(req.body);
  return ApiResponse.ok(res, await adminSwipes.updateSwipeEntitlements(req.user, changes));
}

export async function getMemberSwipeReport(req, res) {
  return ApiResponse.ok(res, await adminSwipes.getMemberSwipeReport(req.params.userId));
}

export async function listSwipes(req, res) {
  const filters = validators.validateSwipeListQuery(req.query);
  return ApiResponse.ok(res, await adminSwipes.listSwipes(filters, parsePagination(req.query)));
}

// ---- Blocks ----

export async function getBlockStats(req, res) {
  const { days } = validators.validateDaysQuery(req.query);
  return ApiResponse.ok(res, await adminBlocks.getBlockStats({ days }));
}

export async function getBlockAnalytics(req, res) {
  const { days } = validators.validateDaysQuery(req.query);
  return ApiResponse.ok(res, await adminBlocks.getBlockAnalytics({ days }));
}

export async function listBlockVelocity(req, res) {
  return ApiResponse.ok(res, await adminBlocks.listBlockVelocity());
}

export async function getMemberBlockReport(req, res) {
  return ApiResponse.ok(res, await adminBlocks.getMemberBlockReport(req.params.userId));
}

export async function getBlock(req, res) {
  return ApiResponse.ok(res, await adminBlocks.getBlockDetail(req.params.blockId));
}

export async function listBlocks(req, res) {
  const filters = validators.validateBlockListQuery(req.query);
  return ApiResponse.ok(res, await adminBlocks.listBlocks(filters, parsePagination(req.query)));
}

// ---- Staff (ADMIN) ----

export async function getStaffStats(req, res) {
  return ApiResponse.ok(res, await adminStaff.getStaffStats());
}

export async function listStaff(req, res) {
  const filters = validators.validateStaffListQuery(req.query);
  return ApiResponse.ok(res, await adminStaff.listStaff(filters, parsePagination(req.query)));
}

export async function getStaff(req, res) {
  return ApiResponse.ok(res, await adminStaff.getStaff(req.user, req.params.userId));
}

export async function createStaff(req, res) {
  const input = validators.validateStaffCreate(req.body);
  return ApiResponse.created(res, await adminStaff.createStaff(req.user, input));
}

export async function updateStaffRole(req, res) {
  const update = validators.validateStaffRoleUpdate(req.body);
  return ApiResponse.ok(res, await adminStaff.updateStaffRole(req.user, req.params.userId, update));
}

export async function updateStaffStatus(req, res) {
  const update = validators.validateStaffStatusUpdate(req.body);
  return ApiResponse.ok(res, await adminStaff.updateStaffStatus(req.user, req.params.userId, update));
}

export async function listStaffSessions(req, res) {
  return ApiResponse.ok(res, await adminStaff.listStaffSessions(req.user, req.params.userId));
}

export async function forceStaffLogout(req, res) {
  const input = validators.validateStaffForceLogout(req.body);
  return ApiResponse.ok(res, await adminStaff.forceStaffLogout(req.user, req.params.userId, input));
}

export async function listStaffActivity(req, res) {
  return ApiResponse.ok(res, await adminStaff.listStaffActivity(req.user, req.params.userId, parsePagination(req.query)));
}

export async function beginTwoFactorSetup(req, res) {
  return ApiResponse.ok(res, await adminStaff.beginTwoFactorSetup(req.user.id));
}

export async function confirmTwoFactorSetup(req, res) {
  const input = validators.validateTwoFactorCodeBody(req.body);
  return ApiResponse.ok(res, await adminStaff.confirmTwoFactorSetup(req.user.id, input));
}

export async function disableTwoFactor(req, res) {
  const input = validators.validateTwoFactorCodeBody(req.body);
  return ApiResponse.ok(res, await adminStaff.disableTwoFactor(req.user.id, input));
}

export async function getRoleStats(req, res) {
  return ApiResponse.ok(res, await adminRoles.getRoleStats());
}

export async function getPermissionCatalog(req, res) {
  return ApiResponse.ok(res, await adminRoles.getPermissionCatalog());
}

export async function listRoles(req, res) {
  return ApiResponse.ok(res, await adminRoles.listRoles());
}

export async function getRole(req, res) {
  return ApiResponse.ok(res, await adminRoles.getRole(req.params.roleId));
}

export async function createRole(req, res) {
  const input = validators.validateRoleCreate(req.body);
  return ApiResponse.created(res, await adminRoles.createRole(req.user, input));
}

export async function updateRole(req, res) {
  const input = validators.validateRoleUpdate(req.body);
  return ApiResponse.ok(res, await adminRoles.updateRole(req.user, req.params.roleId, input));
}

export async function updateRolePermissions(req, res) {
  const input = validators.validateRolePermissionsUpdate(req.body);
  return ApiResponse.ok(res, await adminRoles.updateRolePermissions(req.user, req.params.roleId, input));
}

export async function deleteRole(req, res) {
  const twoFactorCode =
    req.body && typeof req.body.twoFactorCode === 'string' ? req.body.twoFactorCode.trim() : undefined;
  return ApiResponse.ok(res, await adminRoles.deleteRole(req.user, req.params.roleId, { twoFactorCode }));
}

// ---- Profiles ----

export async function getProfileStats(req, res) {
  return ApiResponse.ok(res, await adminProfiles.getProfileStats());
}

export async function listProfiles(req, res) {
  const filters = validators.validateProfileListQuery(req.query);
  return ApiResponse.ok(res, await adminProfiles.listProfiles(filters, parsePagination(req.query)));
}

export async function listPhotoQueue(req, res) {
  const filters = validators.validatePhotoQueueQuery(req.query);
  return ApiResponse.ok(res, await adminProfiles.listPhotoQueue(filters, parsePagination(req.query)));
}

export async function getProfile(req, res) {
  return ApiResponse.ok(res, await adminProfiles.getProfile(req.user.role, req.params.userId));
}

export async function getProfileHistory(req, res) {
  return ApiResponse.ok(res, await adminProfiles.getProfileHistory(req.params.userId, parsePagination(req.query)));
}

export async function updateProfile(req, res) {
  const update = validators.validateAdminProfileUpdate(req.body);
  return ApiResponse.ok(res, await adminProfiles.updateProfile(req.user, req.params.userId, update));
}

export async function updateProfileAccount(req, res) {
  const update = validators.validateProfileAccountUpdate(req.body);
  return ApiResponse.ok(res, await adminProfiles.updateAccount(req.user, req.params.userId, update));
}

export async function updateProfileVisibility(req, res) {
  const update = validators.validateProfileVisibilityUpdate(req.body);
  return ApiResponse.ok(res, await adminProfiles.updateVisibility(req.user, req.params.userId, update));
}

export async function updateProfileBoost(req, res) {
  const update = validators.validateProfileBoostUpdate(req.body);
  return ApiResponse.ok(res, await adminProfiles.updateBoost(req.user, req.params.userId, update));
}

export async function updateProfilePrivacy(req, res) {
  const update = validators.validateProfilePrivacyUpdate(req.body);
  return ApiResponse.ok(res, await adminProfiles.updatePrivacy(req.user, req.params.userId, update));
}

export async function moderateProfilePhoto(req, res) {
  const moderation = validators.validatePhotoModeration(req.body);
  return ApiResponse.ok(
    res,
    await adminProfiles.moderatePhoto(req.user, req.params.userId, req.params.photoId, moderation),
  );
}

export async function removeProfilePhoto(req, res) {
  const removal = validators.validatePhotoRemoval(req.body);
  return ApiResponse.ok(res, await adminProfiles.removeProfilePhoto(req.user, req.params.userId, req.params.photoId, removal));
}

// ---- Messaging / analytics / monitoring ----

export async function getMessagingStats(req, res) {
  const { days } = validators.validateDaysQuery(req.query);
  return ApiResponse.ok(res, await adminMessaging.getMessagingStats({ days }));
}

export async function listConversations(req, res) {
  const filters = validators.validateMessagingListQuery(req.query);
  return ApiResponse.ok(res, await adminMessaging.listConversations(filters, parsePagination(req.query)));
}

export async function getAnalytics(req, res) {
  const { days } = validators.validateDaysQuery(req.query);
  return ApiResponse.ok(res, await adminAnalytics.getAnalytics({ days }));
}

export async function getMonitoring(req, res) {
  return ApiResponse.ok(res, await adminMonitoring.getSystemStatus());
}

// ---- CMS ----

export async function listCms(req, res) {
  const filters = validators.validateCmsListQuery(req.query);
  return ApiResponse.ok(res, await adminCms.listCms(filters, parsePagination(req.query)));
}

export async function getCms(req, res) {
  return ApiResponse.ok(res, await adminCms.getCms(req.params.id));
}

export async function createCms(req, res) {
  const input = validators.validateCmsCreate(req.body);
  return ApiResponse.created(res, await adminCms.createCms(req.user, input));
}

export async function updateCms(req, res) {
  const changes = validators.validateCmsUpdate(req.body);
  return ApiResponse.ok(res, await adminCms.updateCms(req.user, req.params.id, changes));
}

// ---- Coupons (ADMIN) ----

export async function getCouponStats(req, res) {
  return ApiResponse.ok(res, await adminCoupons.getCouponStats());
}

export async function listCoupons(req, res) {
  const filters = validators.validateCouponListQuery(req.query);
  return ApiResponse.ok(res, await adminCoupons.listCoupons(filters, parsePagination(req.query)));
}

export async function createCoupon(req, res) {
  const input = validators.validateCouponCreate(req.body);
  return ApiResponse.created(res, await adminCoupons.createCoupon(req.user, input));
}

export async function updateCoupon(req, res) {
  const changes = validators.validateCouponUpdate(req.body);
  return ApiResponse.ok(res, await adminCoupons.updateCoupon(req.user, req.params.id, changes));
}

// ---- Referrals (ADMIN) ----

export async function getReferralStats(req, res) {
  return ApiResponse.ok(res, await adminReferrals.getReferralStats());
}

export async function listReferrals(req, res) {
  const filters = validators.validateReferralListQuery(req.query);
  return ApiResponse.ok(res, await adminReferrals.listReferrals(filters, parsePagination(req.query)));
}

export async function createReferral(req, res) {
  const input = validators.validateReferralCreate(req.body);
  return ApiResponse.created(res, await adminReferrals.createReferral(req.user, input));
}

export async function updateReferral(req, res) {
  const changes = validators.validateReferralUpdate(req.body);
  return ApiResponse.ok(res, await adminReferrals.updateReferral(req.user, req.params.id, changes));
}

// ---- Fraud ----

export async function getFraudStatus(req, res) {
  return ApiResponse.ok(res, adminFraud.getFraudProviderStatus());
}

export async function listFraudSignals(req, res) {
  const filters = validators.validateFraudSignalListQuery(req.query);
  return ApiResponse.ok(res, await adminFraud.listRiskSignals(filters, parsePagination(req.query)));
}

export async function scanFraudUser(req, res) {
  return ApiResponse.ok(res, await adminFraud.scanUser(req.user, req.params.userId));
}

export async function updateFraudSignal(req, res) {
  const update = validators.validateFraudSignalUpdate(req.body);
  return ApiResponse.ok(res, await adminFraud.updateRiskSignal(req.user, req.params.id, update));
}

// ---- Experiments (ADMIN) ----

export async function listExperiments(req, res) {
  const filters = validators.validateExperimentListQuery(req.query);
  return ApiResponse.ok(res, await adminExperiments.listExperiments(filters, parsePagination(req.query)));
}

export async function getExperiment(req, res) {
  return ApiResponse.ok(res, await adminExperiments.getExperiment(req.params.id));
}

export async function createExperiment(req, res) {
  const input = validators.validateExperimentCreate(req.body);
  return ApiResponse.created(res, await adminExperiments.createExperiment(req.user, input));
}

export async function updateExperiment(req, res) {
  const changes = validators.validateExperimentUpdate(req.body);
  return ApiResponse.ok(res, await adminExperiments.updateExperiment(req.user, req.params.id, changes));
}

// ---- Calls / payments stubs (ADMIN) ----

export async function getCallsStatus(req, res) {
  return ApiResponse.ok(res, adminCalls.getCallsStatus());
}

export async function getPaymentsStatus(req, res) {
  return ApiResponse.ok(res, adminPayments.getPaymentsStatus());
}
