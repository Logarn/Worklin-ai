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

  const sectionBody = description
    ? `## Avatar\n${description}\n`
    : "## Avatar\nNo description yet — describe what the current avatar looks like.\n";

  // Match ## Avatar and its content up to (but not including) the next heading
  // at any level, or end of file. Uses multiline ^ to match headings at line start.
  const avatarSectionRegex = /## Avatar\n[\s\S]*?(?=^#{1,6} |\s*$)/m;

  try {
    await updateIdentityFileAtomically(identityPath, (content) => {
      if (content === null) {
        log?.warn(
          { identityPath },
          "IDENTITY.md not found, skipping avatar section update",
        );
        return undefined;
      }

      if (avatarSectionRegex.test(content)) {
        return content.replace(avatarSectionRegex, sectionBody);
      }
      return content.trimEnd() + "\n\n" + sectionBody + "\n";
    });
  } catch (err) {
    log?.warn({ err }, "Failed to update IDENTITY.md avatar section");
  }
}
