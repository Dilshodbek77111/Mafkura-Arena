import { can, ForbiddenError, requirePermission } from './rbac';

describe('RBAC', () => {
  it('Head Admin hamma huquqqa ega', () => {
    ['admin.manage', 'settings.write', 'audit.view', 'document.view'].forEach((p) => expect(can('HEAD_ADMIN', p as never)).toBe(true));
  });
  it('oddiy Admin: boshqaruv/sozlama/audit yo\'q, kundalik ish bor', () => {
    expect(can('ADMIN', 'admin.manage')).toBe(false);
    expect(can('ADMIN', 'settings.write')).toBe(false);
    expect(can('ADMIN', 'audit.view')).toBe(false);
    expect(can('ADMIN', 'document.review')).toBe(true);
    expect(can('ADMIN', 'question.write')).toBe(true);
  });
  it('requirePermission ForbiddenError tashlaydi', () => {
    expect(() => requirePermission('ADMIN', 'audit.view')).toThrow(ForbiddenError);
  });
});
