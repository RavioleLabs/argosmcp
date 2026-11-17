import React, { useState } from 'react';
import { personalRelease, setupProgress } from './onboarding';

export function SetupExplanation() {
  return (
    <div className="setup-explanation">
      <div>
        <span aria-hidden="true">⌘</span>
        <strong>Your workspace, in the browser</strong>
        <p>Manage your team, tool permissions and AI access here.</p>
      </div>
      <div>
        <span aria-hidden="true">↓</span>
        <strong>Argos Personal, on your computer</strong>
        <p>
          Install the companion app to connect your tools and approve actions. Your tool credentials
          stay on your computer.
        </p>
      </div>
    </div>
  );
}

export function SetupGuide({
  data,
  userId,
  workspaceUrl,
  mcpUrl,
  provider,
  onCopy,
  onRefresh,
  onAgents,
  onDashboard,
  busy,
}: {
  data: any;
  userId: string;
  workspaceUrl: string;
  mcpUrl: string;
  provider?: string;
  onCopy: (text: string) => void;
  onRefresh: () => void;
  onAgents: () => void;
  onDashboard: () => void;
  busy: boolean;
}) {
  const progress = setupProgress(data, userId);
  const [selected, setSelected] = useState<number | null>(null);
  const [tool, setTool] = useState(provider ?? 'notion');
  const current =
    selected ??
    (provider && progress.paired ? 2 : progress.connected ? 3 : progress.paired ? 2 : 0);
  const toolReady =
    progress.paired &&
    (data.connections ?? []).some(
      (c: any) =>
        c.ownerId === userId &&
        c.provider === tool &&
        c.local &&
        !c.demo &&
        c.status === 'active' &&
        c.expiresAt > Date.now(),
    );
  const titles = ['Install the app', 'Pair your computer', 'Connect a tool', 'Add your AI'];
  const done = [progress.paired, progress.paired, progress.connected, progress.authorized];
  return (
    <section className="getting-started" aria-label="Workspace setup guide">
      <SetupExplanation />
      <div className="setup-journey" aria-label="How a tool request works">
        <span>Your AI</span>
        <i aria-hidden="true">→</i>
        <span>
          ArgosMCP<small>Checks company rules</small>
        </span>
        <i aria-hidden="true">→</i>
        <span>
          Argos Personal<small>Runs on your computer</small>
        </span>
        <i aria-hidden="true">→</i>
        <span>Your tools</span>
      </div>
      <p className="setup-caption">
        Results return to your AI through ArgosMCP. Keep Argos Personal open and your computer
        online to run actions.
      </p>
      <div className="setup-guide-body">
        <nav className="setup-steps" aria-label="Setup steps">
          {titles.map((title, index) => (
            <button
              key={title}
              aria-current={current === index ? 'step' : undefined}
              onClick={() => setSelected(index)}
            >
              <span
                className={done[index] ? 'step-done' : ''}
                aria-label={done[index] ? 'Complete' : `Step ${index + 1}`}
              >
                {done[index] ? '✓' : index + 1}
              </span>
              <strong>{title}</strong>
            </button>
          ))}
        </nav>
        <div className="setup-detail" aria-live="polite">
          <span className="eyebrow">STEP {current + 1} OF 4</span>
          {current === 0 && (
            <>
              <h2>Meet Argos Personal.</h2>
              <p>
                A small companion app that connects this workspace to Slack, Notion, Linear and your
                Engram memory. Install it on the computer you’ll use with your AI.
              </p>
              <a className="primary button" href={personalRelease.url}>
                Download for Mac <span aria-hidden="true">↓</span>
              </a>
              <small>Apple silicon · macOS 26 or later · Preview</small>
              <ol className="setup-instructions">
                <li>Download and unzip the app.</li>
                <li>
                  Move <strong>Argos Personal</strong> to your Applications folder.
                </li>
                <li>Open it from Applications. It also lives in your menu bar.</li>
              </ol>
              <div className="setup-availability">
                <strong>About this preview</strong>
                <p>
                  This build is not Apple-notarized. macOS may block it from opening. A signed
                  public installer is not available yet.
                </p>
                <a href={personalRelease.notes} target="_blank" rel="noreferrer">
                  Release details & checksum ↗
                </a>
              </div>
              <details>
                <summary>Intel Mac, Windows or Linux?</summary>
                <p>
                  A ready-to-install app is not available for these platforms yet. Developers can
                  run the connector from source with Node.js.
                </p>
                <a href={personalRelease.source} target="_blank" rel="noreferrer">
                  Source installation instructions ↗
                </a>
              </details>
              <button className="primary" onClick={() => setSelected(1)}>
                I have the app — continue →
              </button>
            </>
          )}
          {current === 1 && (
            <>
              <h2>Link your computer to {data.org.name}.</h2>
              <p>
                In Argos Personal, paste this address into <strong>Company workspace URL</strong>,
                name your device, then choose <strong>Connect this device</strong>.
              </p>
              <label className="setup-copy">
                Company workspace URL
                <input readOnly value={workspaceUrl} onFocus={(e) => e.currentTarget.select()} />
              </label>
              <button onClick={() => onCopy(workspaceUrl)}>Copy workspace URL</button>
              <ol className="setup-instructions">
                <li>
                  In the app, choose <strong>Open workspace</strong>.
                </li>
                <li>Sign in with the same Google account you’re using here.</li>
                <li>
                  Compare the fingerprint in both windows, then confirm the pairing in your browser.
                </li>
              </ol>
              <p className="setup-live" role="status">
                {progress.paired
                  ? progress.online
                    ? '✓ Your device is paired and recently online.'
                    : '✓ Device paired. Open Argos Personal to bring it online.'
                  : 'Waiting for you to pair a device. This page checks automatically.'}
              </p>
              <div className="setup-actions">
                <button disabled={busy} onClick={onRefresh}>
                  Check again
                </button>
                <button
                  className="primary"
                  disabled={!progress.paired}
                  onClick={() => setSelected(2)}
                >
                  Connect a tool →
                </button>
              </div>
            </>
          )}
          {current === 2 && (
            <>
              <h2>Connect your first tool.</h2>
              <p>
                Return to <strong>Argos Personal → Connections</strong>. You sign in with the
                provider there, so its credentials stay on your computer.
              </p>
              <label className="setup-copy">
                Choose a tool
                <select value={tool} onChange={(e) => setTool(e.target.value)}>
                  <option value="notion">Notion</option>
                  <option value="slack">Slack</option>
                  <option value="linear">Linear</option>
                  <option value="engram">Engram memory</option>
                </select>
              </label>
              {tool === 'engram' ? (
                <p>
                  Under <strong>Create an Engram context</strong>, name your memory and choose{' '}
                  <strong>Only me</strong> or <strong>My team</strong>. Personal memory needs no
                  external account. Team memory requires team membership and an administrator role.
                </p>
              ) : (
                <>
                  <ol className="setup-instructions">
                    <li>
                      Under <strong>Connect a tool</strong>, select{' '}
                      {tool === 'slack' ? 'Slack' : tool === 'linear' ? 'Linear' : 'Notion'} and
                      name the connection.
                    </li>
                    <li>
                      Choose <strong>Continue to provider</strong> and authorize access in your
                      browser.
                    </li>
                    <li>Return here. The connection appears automatically after authorization.</li>
                  </ol>
                  {tool !== 'notion' && (
                    <div className="setup-availability">
                      <strong>
                        {tool === 'slack' ? 'Slack' : 'Linear'} needs an OAuth app configured first
                      </strong>
                      <p>
                        This preview requires a public OAuth client ID from your provider app
                        settings. Ask your workspace administrator for it. Never paste a client
                        secret.
                      </p>
                      <a
                        href="https://github.com/RavioleLabs/argosmcp#provider-setup"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Provider setup instructions ↗
                      </a>
                    </div>
                  )}
                </>
              )}
              <p className="setup-caption">
                Notion and personal Engram memory do not require you to supply an OAuth client ID.
                Your company’s access rules still apply. Writes also need confirmation in Argos
                Personal.
              </p>
              <p className="setup-live" role="status">
                {toolReady
                  ? '✓ This tool is connected.'
                  : 'Waiting for this tool to be connected in Argos Personal.'}
              </p>
              <div className="setup-actions">
                <button disabled={busy} onClick={onRefresh}>
                  Check again
                </button>
                <button className="primary" disabled={!toolReady} onClick={() => setSelected(3)}>
                  Add your AI →
                </button>
              </div>
            </>
          )}
          {current === 3 && (
            <>
              <h2>Give your AI a connection.</h2>
              <p>
                In an AI client that supports remote MCP with OAuth, add this as a custom MCP
                server. Sign in with Google, then choose which tools it may access.
              </p>
              <label className="setup-copy">
                MCP server URL
                <input readOnly value={mcpUrl} onFocus={(e) => e.currentTarget.select()} />
              </label>
              <button onClick={() => onCopy(mcpUrl)}>Copy MCP URL</button>
              <p>
                For a bot or a client that needs a token, open <strong>Agents & clients</strong> to
                create scoped access.
              </p>
              <button onClick={onAgents}>Open Agents & clients →</button>
              <div className="setup-availability">
                <strong>Try a first request</strong>
                <p>
                  Ask your AI: “List my available Argos connections.” Then request a read from a
                  connected tool and review any approval in Argos Personal.
                </p>
              </div>
              <p className="setup-live" role="status">
                {progress.authorized
                  ? '✓ AI access is authorized. Run a first request to check your client.'
                  : 'Waiting for an AI client authorization.'}
              </p>
              <button className="primary" onClick={onDashboard}>
                Open dashboard →
              </button>
            </>
          )}
        </div>
      </div>
      <footer>
        <span>
          Each teammate installs and pairs their own app. Your connections remain personal.
        </span>
        <button className="text-button" onClick={onDashboard}>
          Set up later
        </button>
      </footer>
    </section>
  );
}
