-- P1 Task 8: who ran each oa:hosted command. The CLI writes a row before and
-- after every command with the actor: the operator's `git config user.email`
-- on a laptop, or the CI run URL. Rows the provisioner writes on its own
-- leave it NULL. Adding a column is not an UPDATE: the append-only triggers
-- from 0001 still refuse every UPDATE and DELETE.
ALTER TABLE hosted_audit ADD COLUMN actor TEXT;
