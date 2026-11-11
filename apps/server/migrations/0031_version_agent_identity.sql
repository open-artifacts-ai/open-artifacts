-- #1968: the verified bus identity (#1822) of the agent that published a version,
-- JSON {identityId, namespace, name, kind}. Additive, NULL by default, no backfill
-- (a constant-time ALTER): a web publish, an unlinked agent and older rows stay NULL.
-- Server-set. The id never leaves the server; the face fields derived from it
-- (linked, product, animal) do, to members only (#2118, #2004).
ALTER TABLE `versions` ADD `agent_identity` text;