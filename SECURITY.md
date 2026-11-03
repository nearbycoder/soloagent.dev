# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub: open the [Security tab](https://github.com/nearbycoder/soloagent.dev/security) and click **Report a vulnerability** ([direct link](https://github.com/nearbycoder/soloagent.dev/security/advisories/new)). Please don't open a public issue, pull request, or discussion for a security problem.

Include what you found, how to reproduce it (version, deployment type, steps or a proof of concept), and the impact you expect. You should get an acknowledgement within a few days. We'll keep you posted while we work on a fix, and credit you in the advisory unless you'd rather we didn't.

## Supported versions

soloagent is pre-1.0. Security fixes go into the latest release only. Upgrade to get them.

| Version | Supported |
|---|---|
| Latest 0.x release | Yes |
| Older releases | No |

## Security model in brief

soloagent is a **single-tenant**, self-hosted server. Whoever holds the admin token is the operator and can do anything the server can do.

- **Admin token.** Every API call and the WebSocket need `SOLOAGENT_TOKEN`. The only exception is inbound webhooks, which use their own per-webhook secret, compared in constant time. The dashboard keeps the token in an httpOnly cookie. Treat the token like a root password, and serve the dashboard over HTTPS when it is reachable from the internet.
- **Sealed credentials.** Provider credentials (OAuth tokens and API keys), bot tokens, and webhook secrets are encrypted at rest with AES-256-GCM. The key comes from `SOLOAGENT_SECRET`, or from a random secret generated in the data directory on first boot. Anyone who can read both the data directory and that secret can read the credentials, so protect the volume.
- **The `workspace` skill is not a sandbox.** It gives an agent read, write, edit, and `bash` on the server, starting in a per-agent folder but with the server process's full permissions. Anyone who can talk to that agent can steer it, including people in a connected Slack, Discord, or Telegram chat and anyone holding a webhook secret. It is off by default. Grant it only to agents you trust, on a host you're prepared to expose, ideally inside a container.
- **Connectors.** Messages from Slack, Discord, Telegram, and webhooks are untrusted input to a model. Prompt injection through those channels is a known risk of LLM agents, so limit which skills those agents have.

Reports that a token holder can do privileged things, or that an agent with the `workspace` skill can run commands, describe intended behavior. Ways around the token, cookie, or webhook-secret checks, credential leaks, and cross-agent data leaks are vulnerabilities, and we want to hear about them.
