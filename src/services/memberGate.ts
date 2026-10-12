// Who the bot serves: members of the organisation that runs it, nobody else.
//
// Every turn resolves its sender and ensureUserSetup creates an LNbits account
// with Private and Allowance wallets for anyone it has not seen. An app
// installed "for everyone" also reaches the tenant's guests, so without a
// check each guest would get an LNbits account, and any failure on the turn
// an apology message. Fail closed: only a Teams member (userRole "user") of
// this bot's own tenant is set up or answered.

export const ALLOWED_USER_ROLE = 'user';

export interface TeamsMemberLike {
  userRole?: string;
  tenantId?: string;
}

export type MemberVerdict =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        'guest' | 'not_a_member' | 'other_tenant' | 'no_tenant_configured';
    };

export const memberVerdict = (
  member: TeamsMemberLike | null | undefined,
  homeTenantId: string | undefined = process.env.AAD_APP_TENANT_ID,
): MemberVerdict => {
  const home = homeTenantId?.trim().toLowerCase();
  if (!home) {
    return { allowed: false, reason: 'no_tenant_configured' };
  }
  const role = member?.userRole?.trim().toLowerCase();
  if (role === 'guest') {
    return { allowed: false, reason: 'guest' };
  }
  if (role !== ALLOWED_USER_ROLE) {
    return { allowed: false, reason: 'not_a_member' };
  }
  if (member?.tenantId?.trim().toLowerCase() !== home) {
    return { allowed: false, reason: 'other_tenant' };
  }
  return { allowed: true };
};
