# Railway one-click template

A Railway template gives soloagent a **Deploy on Railway** button. It takes about two minutes in the dashboard.

## Why this is manual

Railway's public API and CLI can only create a template *from an existing project* (`railway templates create --project …`, GraphQL `templateGenerate(projectId)`). There is no API that creates a template from a config. Doing it that way means first creating a project with a service, a volume, and a deployment, which costs money. Building the template from scratch in the template editor creates nothing billable, and the editor only exists in the UI.

## Steps (workspace owner, about 2 minutes)

1. Open **https://railway.com/workspace/templates** (pick the **Nearby labs** workspace) and click **New Template**.
2. **Add the service.** Click **Add New**, choose **GitHub Repo**, and enter `https://github.com/nearbycoder/soloagent.dev`. Railway reads the `Dockerfile` and `railway.json` (Dockerfile builder, health check, restart policy). Rename the service to `soloagent`.
3. **Variables tab.** Add:

   | Variable | Value |
   |---|---|
   | `SOLOAGENT_TOKEN` | `${{secret(32)}}` |
   | `SOLOAGENT_SECRET` | `${{secret(32)}}` |
   | `PORT` | `7420` |

   Give `SOLOAGENT_TOKEN` the description: *Admin token for the dashboard, terminal UI, and API. Find it later in the service's Variables tab.* Give `SOLOAGENT_SECRET` the description: *Seals provider credentials and bot tokens at rest. Keep it stable, because changing it means re-entering them.*
4. **Settings tab.**
   - **Public Networking:** enable HTTP, target port `7420`.
   - **Healthcheck Path:** `/healthz` (also set in `railway.json`; set it here anyway so the template shows it).
   - Leave **Replicas** at 1. soloagent runs as a single instance.
5. **Volume.** Right-click the service, choose **Attach Volume**, and set the mount path to **`/data`**. This is where the Docker image keeps its data (`SOLOAGENT_DATA_DIR=/data`).
6. Click **Create Template**. On the templates page, copy the template **code** from its URL (`railway.com/new/template/<code>`, for example `soloagent`).
7. **Optional: publish to the marketplace.** Do this from the template's page, or from the CLI:

   ```bash
   railway templates publish <template-id> --category "AI/ML" \
     --description "Durable AI agents for Slack, Discord, Telegram, webhooks, the web, and your terminal." \
     --readme-file docs/railway-template.md --json
   ```

   `--category` must be one of the marketplace categories (the template page offers a picker). Publishing needs a template README. The "Template README" section below works as one.
8. **Add the button to the README.** In `README.md`, find the `TODO(railway-template)` comment, replace `TEMPLATE_CODE` with the code, uncomment the button, and delete the comment. The site's Railway section (`site/docs/index.html#railway`) can link to the same URL.

The button markdown:

```markdown
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/TEMPLATE_CODE?utm_medium=integration&utm_source=button&utm_campaign=soloagent)
```

## Check that it works

Deploy the template once into a scratch project. It should build from the Dockerfile and pass `/healthz`. Open the generated `*.up.railway.app` domain and sign in with `SOLOAGENT_TOKEN` from the service's Variables tab. Then delete the scratch project.

## Template README

> **soloagent** is an open-source control plane for durable AI agents. Give each agent a name, a personality, a model, and skills, then talk to them from Slack, Discord, Telegram, webhooks, the web dashboard, or your terminal. Every model turn and tool call is committed to storage before it is shown, so redeploys and crashes resume where they stopped.
>
> **After deploying:** open the service's public domain and sign in with the `SOLOAGENT_TOKEN` value from the Variables tab. A built-in demo model answers until you sign in to a provider (Claude, ChatGPT, Copilot, or an API key) on the **Providers** page.
>
> **Connect your terminal:** `soloagent connect https://<your-domain> --token <SOLOAGENT_TOKEN>`
>
> Keep the `/data` volume. Conversations, schedules, and sealed credentials live there. Docs: https://soloagent.dev/docs/
