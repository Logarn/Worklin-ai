import { getWorkspacePromptPath } from "../util/platform.js";
import { updateIdentityFileAtomically } from "../workspace/identity-file-write.js";

/**
 * Update the `## Avatar` section in IDENTITY.md with a plain-text description.
 *
 * If `description` is null, clears the section content (leaves the heading so
 * the assistant knows to fill it in). If the section doesn't exist, appends it.
 */
export async function updateIdentityAvatarSection(
  description: string | null,
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void },
): Promise<void> {
  const identityPath = getWorkspacePromptPath("IDENTITY.md");

  try {
    await updateIdentityFileAtomically(identityPath, (content) => {
      if (content === null) {
        log?.warn(
          { identityPath },
          "IDENTITY.md not found, skipping avatar section update",
        );
        return undefined;
      }

      const newline = content.includes("\r\n") ? "\r\n" : "\n";
      const normalizedDescription = description
        ? description.replace(/\r\n|\r|\n/g, newline)
        : "No description yet — describe what the current avatar looks like.";
      const sectionBody = `## Avatar${newline}${normalizedDescription}${newline}${newline}`;
      const avatarSectionRegex =
        /^##[ \t]+Avatar[ \t]*(?:\r?\n|$)[\s\S]*?(?=^#{1,6}[ \t]+|$(?![\s\S]))/im;

      if (avatarSectionRegex.test(content)) {
        return content.replace(avatarSectionRegex, sectionBody);
      }
      return `${content.trimEnd()}${newline}${newline}${sectionBody}`;
    });
  } catch (err) {
    log?.warn({ err }, "Failed to update IDENTITY.md avatar section");
  }
}
