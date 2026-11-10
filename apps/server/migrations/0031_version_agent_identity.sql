-- #1968: the verified bus identity (#1822) of the agent that published a version,
-- JSON {identityId, namespace, name, kind}. Additive, NULL by default, no backfill
-- (a constant-time ALTER): a web publish, an unlinked agent and older rows stay NULL.
-- Server-set; never in an API payload.
ALTER TABLE `versions` ADD `agent_identity` text;