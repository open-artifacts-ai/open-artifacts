// Whether a share emails an address outside the instance (#2590). Off until
// "Don't email me again" exists (OA Axe's must-have 7): an outside address
// can't opt out of mail from people they don't know, so none is sent. The
// share still saves, and the result says why (notEmailed
// "outside_no_unsubscribe"). outsideShareEmail and the daily limits stay in
// the code behind this switch; turning it on is that one line, once the
// hosted-wide unsubscribe (cloud work) is in.
export const OUTSIDE_SHARE_EMAIL_ON = false;

/**
 * What the code reads: OUTSIDE_SHARE_EMAIL_ON, in an object so the tests that
 * exercise the outside email (templates, limits) can switch it on and back.
 * Nothing else writes it.
 */
export const outsideEmail = { on: OUTSIDE_SHARE_EMAIL_ON };
