import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";

import type { OpenedBrowserState } from "@/stores/viewer-store";

import { BrowserWorkspace } from "./browser-workspace";

const meta: Meta<typeof BrowserWorkspace> = {
  title: "Chat/BrowserWorkspace",
  component: BrowserWorkspace,
  parameters: {
    layout: "fullscreen",
  },
  globals: {
    theme: "dark",
  },
  decorators: [
    (Story) => (
      <div
        data-theme="dark"
        className="h-screen min-h-[480px] bg-[var(--surface-base)]"
      >
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof BrowserWorkspace>;

const readyBrowser: OpenedBrowserState = {
  surfaceId: "browser-preview",
  data: {
    url: "https://example.com/launch-plan",
    title: "Launch plan",
    status: "ready",
    connectionLabel: "Worklin browser",
    updatedAt: Date.now(),
    activity: [
      {
        id: "step-1",
        label: "Opened a page",
        detail: "https://example.com/launch-plan",
        status: "completed",
        timestamp: Date.now() - 60_000,
      },
      {
        id: "step-2",
        label: "Clicked an element",
        status: "completed",
        timestamp: Date.now(),
      },
    ],
  },
};

function BrowserWorkspacePreview({
  browser,
  onClose,
}: {
  browser: OpenedBrowserState;
  onClose: () => void;
}) {
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string>();

  useEffect(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const context = canvas.getContext("2d");
    if (!context) return;

    context.fillStyle = "#f7f8fa";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, 72);
    context.fillStyle = "#15171a";
    context.font = "600 30px sans-serif";
    context.fillText("Launch plan", 64, 47);
    context.fillStyle = "#ffffff";
    context.fillRect(64, 120, 760, 500);
    context.fillStyle = "#15171a";
    context.font = "600 38px sans-serif";
    context.fillText("Campaign launch", 104, 188);
    context.fillStyle = "#747b85";
    context.font = "24px sans-serif";
    context.fillText("Everything the team needs for launch day.", 104, 235);
    context.fillStyle = "#dfe3e8";
    for (let index = 0; index < 5; index += 1) {
      context.fillRect(104, 286 + index * 58, 620 - index * 38, 20);
    }
    context.fillStyle = "#15171a";
    context.fillRect(104, 544, 180, 48);
    context.fillStyle = "#e6f2e8";
    context.fillRect(872, 120, 344, 236);
    context.fillStyle = "#2c6e3f";
    context.font = "600 28px sans-serif";
    context.fillText("Ready to launch", 916, 198);
    context.font = "22px sans-serif";
    context.fillText("12 tasks complete", 916, 244);

    setScreenshotDataUrl(canvas.toDataURL("image/jpeg", 0.78));
  }, []);

  return (
    <BrowserWorkspace
      browser={{
        ...browser,
        data: { ...browser.data, screenshotDataUrl },
      }}
      onClose={onClose}
    />
  );
}

export const Ready: Story = {
  render: (args) => <BrowserWorkspacePreview {...args} />,
  args: {
    browser: readyBrowser,
    onClose: () => {},
  },
};

export const NeedsAttention: Story = {
  render: (args) => <BrowserWorkspacePreview {...args} />,
  args: {
    browser: {
      ...readyBrowser,
      data: {
        ...readyBrowser.data,
        status: "error",
        errorMessage: "Worklin could not complete the latest browser step.",
      },
    },
    onClose: () => {},
  },
};
