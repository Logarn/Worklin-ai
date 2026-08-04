import { SlackLogo } from "@/components/icons/slack-logo";
import { NudgeChatBanner } from "@/components/nudges/nudge-chat-banner";

interface SlackNudgeBannerProps {
  onJoin: () => void;
  onDismiss: () => void;
}

export function SlackNudgeBanner({ onJoin, onDismiss }: SlackNudgeBannerProps) {
  return (
    <NudgeChatBanner
      icon={<SlackLogo size={16} />}
      title="Join our private beta Slack"
      subtitle={
        <>
          <span className="sm:hidden">Invite-only for a small group of beta testers</span>
          <span className="hidden sm:inline">
            Invite-only and currently open to a small group of beta testers
          </span>
        </>
      }
      ctaLabel={
        <>
          <span className="sm:hidden">Join</span>
          <span className="hidden sm:inline-flex items-center gap-1.5">
            <SlackLogo size={16} />
            Join Slack
          </span>
        </>
      }
      ctaAriaLabel="Join the invite-only Worklin Slack group"
      ariaLabel="Join the invite-only Worklin Slack group"
      onAction={onJoin}
      onDismiss={onDismiss}
    />
  );
}
