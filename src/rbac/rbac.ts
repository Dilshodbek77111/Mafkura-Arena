export type AdminRole = 'HEAD_ADMIN' | 'ADMIN';

export const PERMISSIONS = [
  'question.write', 'pack.write', 'user.review', 'document.view', 'document.review', 'complaint.review',
  'answer.review', 'cheat.review', 'certificate.manage', 'namechange.review', 'notification.send',
  'admin.manage', 'settings.write', 'audit.view',
] as const;
export type PermissionKey = (typeof PERMISSIONS)[number];

const HEAD_ONLY: PermissionKey[] = ['admin.manage', 'settings.write', 'audit.view'];

export const ROLE_PERMISSIONS: Record<AdminRole, ReadonlySet<PermissionKey>> = {
  HEAD_ADMIN: new Set(PERMISSIONS),
  ADMIN: new Set(PERMISSIONS.filter((p) => !HEAD_ONLY.includes(p))),
};

export const can = (role: AdminRole, p: PermissionKey): boolean => ROLE_PERMISSIONS[role].has(p);

export class ForbiddenError extends Error {
  constructor(public readonly permission: PermissionKey) { super(`FORBIDDEN:${permission}`); }
}
export function requirePermission(role: AdminRole, p: PermissionKey): void {
  if (!can(role, p)) throw new ForbiddenError(p);
}
