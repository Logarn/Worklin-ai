import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";
import { Typography } from "@vellumai/design-library/components/typography";
import { Check, Copy, Loader2 } from "lucide-react";
import { useState } from "react";

import {
  createArtifactInvitations,
  type ArtifactCollaborationRole,
} from "./artifact-sharing-api";

export function CopybookShareDialog({
  open,
  onClose,
  assistantId,
  copybookId,
}: {
  open: boolean;
  onClose: () => void;
  assistantId: string;
  copybookId: string;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ArtifactCollaborationRole>("commenter");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const close = () => {
    if (pending) return;
    setEmail("");
    setError(null);
    setInviteUrl(null);
    setCopied(false);
    onClose();
  };

  const submit = async () => {
    if (!email.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await createArtifactInvitations({
        assistantId,
        artifactId: `copybook:${copybookId}`,
        recipients: [{ email, role }],
      });
      setInviteUrl(result.invitations[0]?.inviteUrl ?? null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not create this invite.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal.Root open={open} onOpenChange={(next) => !next && close()}>
      <Modal.Content size="sm">
        <Modal.Header>
          <Modal.Title>Share Copybook</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {inviteUrl ? (
            <div className="flex flex-col gap-3">
              <Typography
                variant="body-medium-lighter"
                className="text-[var(--content-secondary)]"
              >
                Your invite is ready. Send this private link to the
                collaborator.
              </Typography>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={inviteUrl}
                  fullWidth
                  aria-label="Copybook invitation link"
                />
                <Button
                  variant="outlined"
                  aria-label="Copy invitation link"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(inviteUrl)
                      .then(() => setCopied(true));
                  }}
                >
                  {copied ? <Check /> : <Copy />}
                </Button>
              </div>
              <Typography
                variant="label-small-default"
                className="text-[var(--content-tertiary)]"
              >
                The link expires in 7 days. Worklin does not email people
                without an explicit sending connection.
              </Typography>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <Typography
                variant="body-medium-lighter"
                className="text-[var(--content-secondary)]"
              >
                Invite someone to this Copybook. They will only have access to
                this work, not your assistant or other brands.
              </Typography>
              <Input
                label="Email address"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="user@example.com"
                fullWidth
                autoFocus
              />
              <label className="flex flex-col gap-1 text-body-small-default text-[var(--content-secondary)]">
                Role
                <select
                  value={role}
                  onChange={(event) =>
                    setRole(event.target.value as ArtifactCollaborationRole)
                  }
                  className="rounded-md border border-[var(--field-border)] bg-[var(--field-bg)] px-3 py-2 text-[var(--content-default)]"
                >
                  <option value="viewer">Viewer — can view</option>
                  <option value="commenter">
                    Commenter — can view and comment
                  </option>
                  <option value="editor">
                    Editor — can view, comment, and edit
                  </option>
                </select>
              </label>
              {error ? (
                <p
                  role="alert"
                  className="m-0 text-body-small-default text-[var(--system-negative-strong)]"
                >
                  {error}
                </p>
              ) : null}
            </div>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outlined" onClick={close} disabled={pending}>
            {inviteUrl ? "Done" : "Cancel"}
          </Button>
          {!inviteUrl ? (
            <Button
              variant="primary"
              onClick={() => void submit()}
              disabled={!email.trim() || pending}
            >
              {pending ? <Loader2 className="animate-spin" /> : null}
              Create invite
            </Button>
          ) : null}
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
