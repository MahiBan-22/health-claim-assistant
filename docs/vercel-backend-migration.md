# Vercel backend migration

The implementation and PostgreSQL provisioning instructions are now in
[Separate Vercel backend setup](vercel-backend.md).

The hosted path uses PostgreSQL (including original files and checkpoints), OpenAI
Responses API, and scheduled checkpointed workflow steps. Local mode remains available.
Live database provisioning, credentials and deployment must be configured as described
in the setup guide; no cloud resources were created by the repository changes.
