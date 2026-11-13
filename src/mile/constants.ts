export const APP_ORIGIN = "https://app.mile.im";
export const API_ORIGIN = "https://alb-tablet.mile.im";

export const READ_ENDPOINTS = new Set([
  "/users/info",
  "/users/member/list",
  "/members/my/info",
  "/members",
  "/meetings/recurring-reservation/check-duplication",
  "/meetings/meeting-room/list",
  "/meetings/meeting-reservation/list",
  "/meetings/meeting-reservation/detail",
  "/meetings/meeting-reservation/my/upcoming",
  "/meetings/meeting-reservation/my/completed",
]);
