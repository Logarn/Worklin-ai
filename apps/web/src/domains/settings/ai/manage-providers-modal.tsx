import { Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";
import { Tag } from "@vellumai/design-library/components/tag";
import { Typography } from "@vellumai/design-library/components/typography";

import {
    inferenceProviderconnectionsGetOptions,
    inferenceProviderconnectionsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { inferenceProviderconnectionsByNameDelete } from "@/generated/daemon/sdk.gen";

import type { ProviderConnection } from "@/generated/daemon/types.gen";
import { PROVIDER_DISPLAY_NAMES } from "@/assistant/llm-model-catalog";
import {
    ProviderEditorContent,
    type ProviderEditorCreateSeed,
} from "@/domains/settings/ai/provider-editor-modal";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAuthSummary(auth: ProviderConnection["auth"]): string {
  switch (auth.type) {
    case "api_key":
      return `API key · ${auth.credential}`;
    case "oauth_subscription":
      return "ChatGPT subscription";
    case "platform":
      return "Worklin credits";
    case "none":
      return "None (local)";
    default:
      return auth.type;
  }
}

export interface ProviderCreateSeed extends ProviderEditorCreateSeed {
  nonce: number;
}

// ---------------------------------------------------------------------------
// ManageProvidersModal
// ---------------------------------------------------------------------------

interface ManageProvidersModalProps {
  isOpen: boolean;
  assistantId: string;
  createSeed?: ProviderCreateSeed | null;
  onClose: () => void;
}

export function ManageProvidersModal({
  isOpen,
  assistantId,
  createSeed,
  onClose,
}: ManageProvidersModalProps) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<ProviderConnection | null>(null);
  const [activeCreateSeed, setActiveCreateSeed] =
    useState<ProviderEditorCreateSeed | null>(null);

  const queryClient = useQueryClient();
  const queryOpts = inferenceProviderconnectionsGetOptions({
    path: { assistant_id: assistantId },
  });
  const { data, isLoading: loading, isError } = useQuery({
    ...queryOpts,
    enabled: isOpen,
  });

  const connections = useMemo(
    () => data?.connections ?? [],
    [data],
  );

  function handleEditorSave(_saved: ProviderConnection) {
    void queryClient.invalidateQueries({
      queryKey: inferenceProviderconnectionsGetQueryKey({
        path: { assistant_id: assistantId },
      }),
    });
    setEditorOpen(false);
    setEditingConnection(null);
    setActiveCreateSeed(null);
  }

  const existingNames = connections.map((c) => c.name);

  useEffect(() => {
    if (!isOpen || !createSeed) return;
    setEditingConnection(null);
    setActiveCreateSeed({
      provider: createSeed.provider,
      authType: createSeed.authType,
      preset: createSeed.preset,
    });
    setEditorOpen(true);
  }, [createSeed, isOpen]);

  // Cancel the editor: returns to list view without saving. Used by the
  // editor's footer Cancel button AND by view-aware onOpenChange when the
  // user dismisses the modal while in editor view (X / ESC / backdrop click).
  const cancelEditor = () => {
    setEditorOpen(false);
    setEditingConnection(null);
    setActiveCreateSeed(null);
  };

  // Single Modal.Root for both views (list + editor). Body content swaps
  // based on `editorOpen` — this is the master/detail pattern, matching the
  // macOS `ProvidersSheet` flow. View-aware `onOpenChange`: a close
  // intent (X / ESC / backdrop) returns to the list when in editor view,
  // and closes the whole modal when in list view.
  return (
    <Modal.Root
      open={isOpen}
      onOpenChange={(next) => {
        if (next) return;
        if (editorOpen) {
          cancelEditor();
        } else {
          onClose();
        }
      }}
    >
      {isOpen ? (
        editorOpen ? (
          <ProviderEditorContent
            key={
              editingConnection
                ? `edit:${editingConnection.name}`
                : activeCreateSeed
                  ? `create:${activeCreateSeed.provider}:${activeCreateSeed.authType ?? "default"}:${createSeed?.nonce ?? 0}`
                  : "create"
            }
            mode={
              !editingConnection
                ? "create"
                : editingConnection.isManaged
                  ? "managed-edit"
                  : "edit"
            }
            connection={editingConnection ?? undefined}
            createSeed={activeCreateSeed ?? undefined}
            assistantId={assistantId}
            existingNames={existingNames}
            onSave={handleEditorSave}
            onCancel={cancelEditor}
          />
        ) : (
          <ManageProvidersModalInner
            connections={connections}
            loading={loading}
            isError={isError}
            assistantId={assistantId}
            onClose={onClose}
            onEditClick={(conn) => {
              setEditingConnection(conn);
              setActiveCreateSeed(null);
              setEditorOpen(true);
            }}
            onNewClick={() => {
              setEditingConnection(null);
              setActiveCreateSeed(null);
              setEditorOpen(true);
            }}
            onConnectionDeleted={() => {
              void queryClient.invalidateQueries({
                queryKey: inferenceProviderconnectionsGetQueryKey({
                  path: { assistant_id: assistantId },
                }),
              });
            }}
          />
        )
      ) : null}
    </Modal.Root>
  );
}

// ---------------------------------------------------------------------------
// ManageProvidersModalInner
// ---------------------------------------------------------------------------

interface ManageProvidersModalInnerProps {
  connections: ProviderConnection[];
  loading: boolean;
  isError: boolean;
  assistantId: string;
  onClose: () => void;
  onEditClick: (conn: ProviderConnection) => void;
  onNewClick: () => void;
  onConnectionDeleted: (name: string) => void;
}

function ManageProvidersModalInner({
  connections,
  loading,
  isError,
  assistantId,
  onClose,
  onEditClick,
  onNewClick,
  onConnectionDeleted,
}: ManageProvidersModalInnerProps) {
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});

  async function handleDelete(name: string) {
    setDeleting((prev) => ({ ...prev, [name]: true }));
    setDeleteErrors((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    try {
      const { response } = await inferenceProviderconnectionsByNameDelete({
        path: { assistant_id: assistantId, name },
      });
      if (response?.ok || response?.status === 404) {
        // 404 means already gone — still remove from local list.
        onConnectionDeleted(name);
      } else if (response?.status === 409) {
        setDeleteErrors((prev) => ({
          ...prev,
          [name]:
            "Service is in use by one or more saved setups. Remove those references first.",
        }));
      } else {
        setDeleteErrors((prev) => ({
          ...prev,
          [name]: "Failed to delete connection. Please try again.",
        }));
      }
    } catch {
      setDeleteErrors((prev) => ({
        ...prev,
        [name]: "Failed to delete connection. Please try again.",
      }));
    } finally {
      setDeleting((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    }
  }

  return (
    <Modal.Content size="md">
      <Modal.Header>
        <Modal.Title>API keys & services</Modal.Title>
        <Modal.Description>
          Connect the model services Worklin can use for replies.
        </Modal.Description>
      </Modal.Header>

      <Modal.Body>
        {loading ? (
          <div className="space-y-2 py-2">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-10 animate-pulse rounded-lg bg-[var(--surface-active)]"
              />
            ))}
          </div>
        ) : isError ? (
          <Typography
            variant="body-medium-default"
            as="p"
            className="py-4 text-center text-(--system-negative-strong)"
          >
            Failed to load connections. Please try again.
          </Typography>
        ) : connections.length === 0 ? (
          <Typography
            variant="body-medium-lighter"
            as="p"
            className="py-4 text-center text-(--content-tertiary)"
          >
            No services yet. Add one to get started.
          </Typography>
        ) : (
          <div className="space-y-1">
            {connections.map((conn) => {
              const isDeleting = deleting[conn.name] ?? false;
              const deleteError = deleteErrors[conn.name];
              const isManaged = conn.isManaged ?? false;

              return (
                <div key={conn.name}>
                  <div className="flex items-center gap-3 rounded-lg px-2 py-2">
                    {/* Connection info */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Typography
                          variant="body-medium-default"
                          as="span"
                          className="text-(--content-default)"
                        >
                          {conn.label ?? conn.name}
                        </Typography>
                        {isManaged && (
                          <Tag
                            tone="positive"
                            title="Uses Worklin credits — auth is locked, but you can rename this service."
                          >
                            Worklin credits
                          </Tag>
                        )}
                      </div>
                      <Typography
                        variant="body-medium-lighter"
                        as="p"
                        className="mt-0.5 text-(--content-tertiary)"
                      >
                        {conn.label ? `${conn.name} · ` : ""}
                        {PROVIDER_DISPLAY_NAMES[conn.provider] ?? conn.provider}
                        {" · "}
                        {formatAuthSummary(conn.auth)}
                      </Typography>
                    </div>

                    {/* Actions */}
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        variant="ghost"
                        size="compact"
                        onClick={() => onEditClick(conn)}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="compact"
                        iconOnly={<Trash2 />}
                        aria-label={`Delete ${conn.name}`}
                        disabled={isManaged || isDeleting}
                        title={
                          isManaged
                            ? "Worklin credit services cannot be deleted"
                            : undefined
                        }
                        onClick={() => void handleDelete(conn.name)}
                        tintColor="var(--system-negative-strong)"
                      />
                    </div>
                  </div>

                  {deleteError ? (
                    <Typography
                      variant="body-small-default"
                      as="p"
                      className="px-2 pb-1 text-(--system-negative-strong)"
                    >
                      {deleteError}
                    </Typography>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </Modal.Body>

      <Modal.Footer className="justify-between">
        <Button variant="outlined" size="compact" onClick={onNewClick}>
          + Add service
        </Button>
        <Button variant="outlined" size="compact" onClick={onClose}>
          Done
        </Button>
      </Modal.Footer>
    </Modal.Content>
  );
}
