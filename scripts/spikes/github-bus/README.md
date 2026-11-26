# GitHub webhook to bus event

Run the spike from the repository root using Node 22.13 or later.

```sh
node --test scripts/spikes/github-bus/webhook.test.mjs
```

`receive` verifies HMAC-SHA-256 over the supplied bytes before parsing, checks the installation, repository and sender against a supplied binding, then hands a fixed-format event to an injected sink. `recipients` matches pre-authorized PR or workflow follows. A group event requires a known group SHA. Check completion requires a matching PR head. The integration test sends a signed review twice and checks the one message delivered to the matching local inbox.

The seven entries in [recordings.json](fixtures/recordings.json) project fields from public Octokit webhook recordings. Each includes its source URL and upstream Git blob SHA. Three recordings omit the App installation envelope. Tests explicitly add a fixture installation to copies of those bodies and cover rejection of the original missing-installation input. Failure, rerun, dequeue, merge and invalidation variants are derived test cases. Each run generates a non-exportable HMAC key in memory. Tests use local data and promises.

The sink models atomic acceptance and replay suppression in memory. Production still needs durable acceptance and retries, installation lifecycle, actor and follower authorization, causal state across deliveries, and a GitHub notice type in the hub protocol. The branch registers no Worker route. The [spike page](https://artifacts.leourbina.com/a/3PCfQjcubAtohvfj) covers setup, estimates and live acceptance.
