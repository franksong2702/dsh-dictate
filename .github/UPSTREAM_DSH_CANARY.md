# Upstream DSH compatibility canary

The declared compatibility baseline remains explicit in `compatibility.json` and the package peer ranges. The upstream canary is a separate early-warning signal: it resolves one immutable snapshot of `@deepseek-ai/dsh@latest` and `@deepseek-ai/dsh@next`, then installs the packed `dsh-dictate` artifact into an isolated temporary DSH profile for every unique candidate that differs from the declared baseline.

The canary checks package installation, DSH profile configuration, the Web profile's help-only startup path, host-module imports, and the bundled client entry. The help probe lets the official launcher prepare its profile module fallback inside the temporary `DSH_HOME`, then requires app help with no server URL or stderr and does not enter Web server startup. It does not start a model provider, access OAuth, use a microphone, or require the optional local ASR runtime/model. Those are separate test-profile and release gates.

## Alert behavior

One failed candidate check is retried unchanged against the same resolved dist-tag snapshot. Two matching failures create or update one version-deduplicated issue only when both reports classify the same candidate as a compatibility failure. Registry failures, network failures, command timeouts, and unknown checker errors fail the workflow without creating an issue.

The workflow has no publish, release, deployment, merge, or persistent profile mutation permission. Candidate profiles live below a temporary `DSH_HOME` and are removed after each check. The canary provisions pnpm 10 and disables pnpm's project-version auto-switch so DSH's nested profile install uses that same major version. Credential-bearing environment variables are scrubbed before an undeclared candidate is executed.

## Response procedure

1. Open the linked workflow run and record the candidate version, failed stage, plugin commit, and bounded summary.
2. Reproduce the exact candidate from the reported commit:

   ```sh
   npm_config_manage_package_manager_versions=false DSH_VERSION=<reported-version> DSH_UNDECLARED_CANARY_VERSION=1 pnpm --silent run check:dsh-install
   ```

3. Treat a `next` failure as an early warning and a `latest` failure as a possible new-install regression.
4. Keep `compatibility.json` and peer ranges unchanged until the candidate passes the isolated check and the test profile covers any required DSH behavior.
5. Record the reproduction, fix, checks, and released plugin version in the alert issue before closing it.

## Manual commands

```sh
pnpm --silent run check:dsh-next -- --channel latest
pnpm --silent run check:dsh-next -- --channel next
```

Exit codes are `0` for unchanged, deduplicated, or compatible candidates; `1` for a confirmed compatibility failure; and `2` for candidate resolution or checker infrastructure failures.
