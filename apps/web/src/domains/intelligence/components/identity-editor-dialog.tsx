import {
  type FormEvent,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button, Input, Modal, Textarea } from "@vellumai/design-library";

import {
  type AssistantIdentityUpdate,
  updateAssistantIdentity,
} from "@/assistant/identity";
import type { IdentityGetResponse } from "@/generated/daemon/types.gen";
import { captureError } from "@/lib/sentry/capture-error";

export type EditableIdentityField = keyof AssistantIdentityUpdate;

interface IdentityEditorConfig {
  label: string;
  maxLength: number;
  title: string;
}

const IDENTITY_EDITOR_CONFIG: Record<
  EditableIdentityField,
  IdentityEditorConfig
> = {
  name: {
    label: "Name",
    maxLength: 100,
    title: "Edit name",
  },
  role: {
    label: "Role",
    maxLength: 500,
    title: "Edit role",
  },
  personality: {
    label: "Personality",
    maxLength: 1_000,
    title: "Edit personality",
  },
};

type SaveState =
  { kind: "idle" } | { kind: "saving" } | { kind: "error"; message: string };

interface IdentityEditorDialogProps {
  assistantId: string;
  field: EditableIdentityField;
  initialValue: string;
  onClose: () => void;
  onSaved: (assistantId: string, identity: IdentityGetResponse) => void;
}

function IdentityEditorSession({
  assistantId,
  field,
  initialValue,
  onClose,
  onSaved,
}: IdentityEditorDialogProps) {
  const config = IDENTITY_EDITOR_CONFIG[field];
  const [value, setValue] = useState(initialValue);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const isActiveRef = useRef(true);

  useLayoutEffect(
    () => () => {
      isActiveRef.current = false;
    },
    [],
  );

  const trimmedValue = value.trim();
  const hasLineBreak = /[\r\n]/.test(value);
  const isSaving = saveState.kind === "saving";
  const canSave =
    trimmedValue.length > 0 &&
    trimmedValue.length <= config.maxLength &&
    !hasLineBreak &&
    !isSaving;

  const handleSave = useCallback(async () => {
    if (!canSave) return;

    setSaveState({ kind: "saving" });
    try {
      const update: AssistantIdentityUpdate =
        field === "name"
          ? { name: trimmedValue }
          : field === "role"
            ? { role: trimmedValue }
            : { personality: trimmedValue };
      const identity = await updateAssistantIdentity(assistantId, update);
      onSaved(assistantId, identity);
      if (!isActiveRef.current) return;

      onClose();
    } catch (error) {
      if (!isActiveRef.current) return;

      captureError(error, {
        context: "identity_editor_save",
        tags: { assistantId, field },
      });
      setSaveState({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Could not save the assistant identity.",
      });
    }
  }, [assistantId, canSave, field, onClose, onSaved, trimmedValue]);

  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      void handleSave();
    },
    [handleSave],
  );

  const errorText = hasLineBreak
    ? `${config.label} must be a single line.`
    : saveState.kind === "error"
      ? saveState.message
      : undefined;

  return (
    <Modal.Root
      open
      onOpenChange={(open) => {
        if (!open && !isSaving) {
          onClose();
        }
      }}
    >
      <Modal.Content
        size="sm"
        hideCloseButton={isSaving}
        aria-describedby={undefined}
      >
        <form onSubmit={handleSubmit}>
          <Modal.Header>
            <Modal.Title>{config.title}</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            {field === "name" ? (
              <Input
                autoFocus
                fullWidth
                label={config.label}
                value={value}
                maxLength={config.maxLength}
                disabled={isSaving}
                errorText={errorText}
                onChange={(event) => {
                  setValue(event.target.value);
                  if (saveState.kind === "error") {
                    setSaveState({ kind: "idle" });
                  }
                }}
              />
            ) : (
              <Textarea
                autoFocus
                fullWidth
                label={config.label}
                value={value}
                maxLength={config.maxLength}
                rows={4}
                disabled={isSaving}
                errorText={errorText}
                onChange={(event) => {
                  setValue(event.target.value);
                  if (saveState.kind === "error") {
                    setSaveState({ kind: "idle" });
                  }
                }}
              />
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button
              type="button"
              variant="outlined"
              disabled={isSaving}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!canSave}>
              {isSaving ? "Saving..." : "Save"}
            </Button>
          </Modal.Footer>
        </form>
      </Modal.Content>
    </Modal.Root>
  );
}

export function IdentityEditorDialog(props: IdentityEditorDialogProps) {
  return (
    <IdentityEditorSession
      key={`${props.assistantId}:${props.field}`}
      {...props}
    />
  );
}
