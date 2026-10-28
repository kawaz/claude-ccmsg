// The wire's generation, apart from the build's version (version.ts): the
// generation changes only by hand, so the hooks module bundles this file, and
// its bundle does not change with every release as the build's version would.

/**
 * Wire protocol generation, bumped by hand — never by a release — whenever a
 * change makes an existing client's `hello`, `subscribe`, event reception, or
 * ordinary ops stop working against the new daemon. The daemon rejects a hello
 * announcing a different generation instead of serving it: ccmsg evolves per
 * host, all at once, with no compatibility path (DR-0002 §4).
 *
 * Generation 1 is the `request_id` correlation envelope every request carries
 * (DR-0029 追補).
 */
export const PROTOCOL_VERSION = 1;

/**
 * The generation of a client whose hello carries no `protocol` field at all:
 * generation 1, the generation during which the field itself was introduced.
 *
 * This is the definition of what those clients speak, not a compatibility path
 * — nothing downstream branches on "announced vs assumed", it is simply the
 * number they mean. Getting this wrong in the other direction would be a false
 * alarm at scale: every subscribe running today predates the field, is fully
 * compatible, and would otherwise be flagged as stale the moment this ships,
 * asking kawaz to restart every session on his machine for nothing.
 *
 * It follows that when `PROTOCOL_VERSION` next moves, these clients are
 * refused like any other generation-1 client — by then that is exactly what
 * they are.
 */
export const UNANNOUNCED_PROTOCOL_VERSION = 1;
