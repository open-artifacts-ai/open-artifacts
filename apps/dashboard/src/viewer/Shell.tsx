import { type ArtifactSummary, type Me, viewerPath } from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ApiClientError } from "../api/client";
import { useArtifact, useVersionInfo } from "../api/queries";
import { useCan } from "../auth/permissions";
import { useLoginRedirect } from "../auth/redirect";
import { useMe } from "../auth/useMe";
import { isEmbed } from "../embed";
import { useCpuSignals } from "../layout/cpu";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { NotFound } from "../pages/NotFound";
import { NotPublic } from "../pages/NotPublic";
import { createBridge } from "./bridge";
import { Crumbs } from "./Crumbs";
import { FullScreenEscape } from "./FullScreenEscape";
import { frameLoad, SANDBOX, safeContentUrl } from "./frame";
import { FullLive, GoneBanner, LiveAnnouncer, TitleLive } from "./LiveChip";
import { createNavigator } from "./navigate";
import { isPanelTab, type PanelTab, SidePanel } from "./panels/SidePanel";
import { RenavNotice } from "./RenavNotice";
import { SlowNotice } from "./SlowNotice";
import { TitleBar } from "./TitleBar";
import { useArtifactSideEffects } from "./useArtifactSideEffects";
import { useContentUrl } from "./useContentUrl";
import { type FrameState, type Gone, useLiveVersions } from "./useLiveVersions";
import { useTheme } from "./useTheme";
import "./viewer.css";
import { fullPath } from "./paths";

type Bridge = ReturnType<typeof createBridge>;

// One navigator for every viewer, so the rate limit survives the remount a
// navigation causes. `go` is the mounted viewer's router navigate.
const artifactNav = { go: (_path: string) => {} };
const onArtifactNavigate = createNavigator((p) => artifactNav.go(p));

/** No hello this long after the frame loaded: hint that it may be stuck. */
export const SLOW_MS = 8_000;

function ErrorPanel({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="oa-edge" role="alert">
      <section className="oa-panel">
        <h1>Couldn't load this artifact</h1>
        <p>Something went wrong. Try again in a moment.</p>
        {onRetry && (
          <Button variant="outline" onClick={onRetry}>
            Retry
          </Button>
        )}
      </section>
    </div>
  );
}

function Viewer({
  artifact,
  version,
  explicitVersion,
  authed,
  viewer,
  role,
  plan,
  chromeless,
  slot,
  newer = false,
  gone = null,
  onFrame,
  onReady,
  onTouched,
  onAccessLost,
  onUndelete,
}: {
  chromeless: boolean;
  /** The live-version chip (title bar) or pill (/full); only on the shown layer. */
  slot?: ReactNode;
  newer?: boolean;
  gone?: Gone | null;
  /** Registers this frame's state (hello, touched) for the safe-swap rule. */
  onFrame?: (s: FrameState) => void;
  /** The artifact loaded (or failed to): a preloaded layer can be shown. */
  onReady?: () => void;
  /** The viewer touched the frame (runtime `interacted`, or focus inside it). */
  onTouched?: () => void;
  /** A data socket closed with 4403: the shell re-checks access. */
  onAccessLost?: () => void;
  /** The owner's Restore of an artifact deleted while open. */
  onUndelete?: () => Promise<void>;
  role: Me["user"]["role"] | undefined;
  plan: Me["instance"]["plan"] | undefined;
  artifact: ArtifactSummary;
  version: number;
  explicitVersion: boolean;
  authed: boolean;
  viewer: { email: string; name: string | null } | null;
}) {
  const content = useContentUrl(artifact.id, version, gone !== null);
  const url = safeContentUrl(content.url);
  const signedOut =
    content.error instanceof ApiClientError && content.error.status === 401;
  useLoginRedirect(
    signedOut,
    chromeless
      ? fullPath(artifact.id)
      : viewerPath(artifact.id, explicitVersion ? version : undefined),
  );
  const theme = useTheme();
  const [el, setEl] = useState<HTMLIFrameElement | null>(null);
  const navigate = useNavigate();
  artifactNav.go = (p) => void navigate({ to: p as string });
  const search = useSearch({ strict: false }) as {
    panel?: string;
    tab?: string;
  };
  const panelOpen = search.panel === "open";
  const tab: PanelTab = isPanelTab(search.tab) ? search.tab : "versions";
  const setPanel = (open: boolean, t: PanelTab = tab) =>
    void navigate({
      to: ".",
      replace: true,
      search: ((p: Record<string, unknown>) => ({
        ...p,
        panel: open ? "open" : "closed",
        tab: t,
      })) as never,
    });
  const bridge = useRef<Bridge | null>(null);
  // Latest values for the effect: the parent's key remounts this on id/version change.
  const vformat = useVersionInfo(artifact.id, version).data?.format;
  const formatRef = useRef(vformat);
  formatRef.current = vformat;
  const latest = useRef({ artifact, viewer, theme });
  latest.current = { artifact, viewer, theme };
  const fx = useArtifactSideEffects(
    artifact,
    version,
    () => bridge.current?.requestThumbnail() ?? false,
  );
  const fxRef = useRef(fx);
  fxRef.current = fx;

  // The slow notice: armed on each frame load, cleared by hello, gone for this view
  // once dismissed. Reloading remounts the frame (and so the bridge) with a fresh
  // URL; one reload per frame load, so a double click counts once.
  const cpu = useCpuSignals(role, plan);
  // Since this frame's last intentional load: did the runtime say hello, has
  // the viewer touched it. Read by the safe-swap rule.
  const fs = useRef<FrameState>({ hello: false, touched: false });
  const cbs = useRef({ onReady, onTouched, onAccessLost });
  cbs.current = { onReady, onTouched, onAccessLost };
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on mount
  useEffect(() => {
    onFrame?.(fs.current);
  }, []);
  const touch = useCallback(() => {
    if (fs.current.touched) return;
    fs.current.touched = true;
    cbs.current.onTouched?.();
  }, []);
  const helloSeen = useRef(false);
  const slowTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dismissed = useRef(false);
  const reloading = useRef(false);
  const [slow, setSlow] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [frame, setFrame] = useState<{ key: number; src: string | null }>({
    key: 0,
    src: null,
  });
  // The renavigation notice: the frame left the page we loaded, so its bridge
  // is gone. Only artifacts with live data lose anything. Each later load in
  // that frame is another navigation and brings a dismissed notice back.
  const caps = artifact.capabilities;
  const live = caps.db || caps.viewer || caps.storage;
  const can = useCan(artifact);
  const renavigated = useRef(false);
  const [renav, setRenav] = useState(false);
  const onRenavigated = useCallback(() => {
    renavigated.current = true;
    // The viewer followed a link inside the artifact.
    touch();
    // No bridge, so no hello: the slow notice would be wrong.
    clearTimeout(slowTimer.current);
    setSlow(false);
    setRenav(live);
  }, [live, touch]);
  const onHello = useCallback(() => {
    helloSeen.current = true;
    fs.current.hello = true;
    clearTimeout(slowTimer.current);
    setSlow(false);
  }, []);
  const contentLoaded = content.onLoad;
  const onFrameLoad = useCallback(
    (e: SyntheticEvent<HTMLIFrameElement>) => {
      // No src prop, so a new frame first loads about:blank, before the bridge
      // calls loadArtifactFrame. That load isn't the artifact: it must neither
      // freeze the content URL nor arm the slow timer.
      if (!frameLoad(e.currentTarget)) return;
      if (renavigated.current) {
        setRenav(live);
        return;
      }
      contentLoaded();
      cbs.current.onReady?.();
      reloading.current = false;
      clearTimeout(slowTimer.current);
      if (helloSeen.current || dismissed.current) return;
      slowTimer.current = setTimeout(() => {
        if (!helloSeen.current) setSlow(true);
      }, SLOW_MS);
    },
    [contentLoaded, live],
  );
  useEffect(() => () => clearTimeout(slowTimer.current), []);
  const reload = () => {
    if (reloading.current) return;
    reloading.current = true;
    helloSeen.current = false;
    fs.current.hello = false;
    fs.current.touched = false;
    clearTimeout(slowTimer.current);
    setSlow(false);
    renavigated.current = false;
    setRenav(false);
    setReloads((r) => r + 1);
    const ready = content.fresh()
      ? Promise.resolve(content.current)
      : content.refresh();
    void ready.then((u) =>
      setFrame((f) => ({ key: f.key + 1, src: safeContentUrl(u) ?? f.src })),
    );
  };

  // Every intentional load (first load, a refreshed URL before the first load,
  // Reload) gets a fresh bridge, which loads the frame with a fresh nonce.
  const src = frame.src ?? url;
  useEffect(() => {
    if (!el || !src || gone) return;
    const b = createBridge({
      iframe: el,
      url: src,
      ...latest.current,
      version,
      formatOf: () => formatRef.current,
      onHello: () => {
        onHello();
        fxRef.current.onHello();
      },
      onPdfText: (t) => fxRef.current.onPdfText(t),
      onThumb: (b) => fxRef.current.onThumb(b),
      // The shell re-checks access: still readable, or the gone state.
      onAccessLost: () => cbs.current.onAccessLost?.(),
      onRenavigated,
      onNavigate: onArtifactNavigate,
      onInteracted: touch,
    });
    bridge.current = b;
    return () => {
      b.dispose();
      bridge.current = null;
    };
  }, [el, src, version, onHello, onRenavigated, touch, gone]);

  // Focus moved into the frame (a window blur with the frame active): touched.
  useEffect(() => {
    if (!el) return;
    const onBlur = () =>
      setTimeout(() => {
        if (document.activeElement === el) touch();
      }, 0);
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [el, touch]);

  // A preload that can't load the artifact still swaps in, to show why.
  const failed = !url && Boolean(content.current || content.error);
  useEffect(() => {
    if (failed) cbs.current.onReady?.();
  }, [failed]);

  useEffect(() => bridge.current?.setTheme(theme), [theme]);

  if ((content.notFound || signedOut) && isEmbed())
    return <NotPublic id={artifact.id} />;
  if (content.notFound) return <NotFound />;
  if (signedOut) return null;
  return (
    <div className="oa-viewer">
      {!chromeless && (
        <>
          <Crumbs title={artifact.title} />
          <TitleBar
            artifact={artifact}
            version={version}
            explicitVersion={explicitVersion}
            authed={authed}
            onShare={() => setPanel(true, "share")}
            versionsOpen={panelOpen && tab === "versions"}
            onVersions={() =>
              setPanel(!(panelOpen && tab === "versions"), "versions")
            }
            live={slot}
            newer={newer}
            gone={gone !== null}
          />
          {gone && (
            <GoneBanner
              gone={gone}
              owner={artifact.access === "owner"}
              onRestore={onUndelete ?? (async () => {})}
              authed={authed}
              next={viewerPath(artifact.id)}
            />
          )}
        </>
      )}
      <div className="oa-vbody">
        {!url && (content.current || content.error) ? (
          <ErrorPanel onRetry={() => void content.refresh()} />
        ) : null}
        {url && (
          <div className="oa-vmain">
            {renav && (
              <RenavNotice
                onReload={reload}
                onDismiss={() => setRenav(false)}
              />
            )}
            {slow && (
              <SlowNotice
                cpu={(cpu.hits ?? 0) > 0 || cpu.recent}
                reloads={reloads}
                admin={cpu.admin}
                paid={cpu.paid}
                onReload={reload}
                onDismiss={() => {
                  dismissed.current = true;
                  clearTimeout(slowTimer.current);
                  setSlow(false);
                }}
              />
            )}
            {/* No src prop: the bridge sets it (loadArtifactFrame). */}
            <iframe
              key={frame.key}
              ref={setEl}
              className="oa-vframe"
              onLoad={onFrameLoad}
              title={artifact.title}
              sandbox={SANDBOX}
              referrerPolicy="no-referrer"
              allow="clipboard-write"
            />
          </div>
        )}
        {panelOpen && authed && !chromeless && (
          <SidePanel
            artifact={artifact}
            version={version}
            tab={tab}
            onTab={(t) => setPanel(true, t)}
            onClose={() => setPanel(false)}
          />
        )}
      </div>
      {/* After the frame, so it is the top document's only Tab stop. */}
      {chromeless && (
        <FullScreenEscape
          artifact={artifact}
          live={slot}
          gone={gone !== null}
        />
      )}
    </div>
  );
}

/** The artifact viewer; `chromeless` is the full-screen view (#290): the frame
    and bridge only, with the same access and loading states. */
export function Shell(props: { id: string; v?: number; chromeless?: boolean }) {
  // A new id starts over: its own events socket and live state.
  return <ArtifactShell key={props.id} {...props} />;
}

/** A menu, dialog or the side panel is open (the safe swap waits for it). */
const chromeOpen = (panelOpen: boolean) =>
  panelOpen ||
  document.querySelector(
    '[role="menu"],[role="dialog"],[role="alertdialog"]',
  ) !== null;

function ArtifactShell({
  id,
  v,
  chromeless = false,
}: {
  id: string;
  v?: number;
  chromeless?: boolean;
}) {
  const q = useArtifact(id);
  const me = useMe();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { panel?: string };
  const panelOpen = useRef(false);
  panelOpen.current = search.panel === "open";
  const embed = isEmbed();
  // Deleted or made private while open: keep what's on screen (never blank it).
  const last = useRef<ArtifactSummary | undefined>(undefined);
  if (q.data) last.current = q.data;
  const data = q.data ?? last.current;

  // Each layer's frame state, by version; the shown one decides a swap.
  const frames = useRef(new Map<number, FrameState>());
  const shownRef = useRef<number | undefined>(undefined);
  const live = useLiveVersions({
    id,
    data,
    explicit: v,
    chromeless,
    embed,
    frame: () =>
      frames.current.get(shownRef.current ?? -1) ?? {
        hello: false,
        touched: true,
      },
    chromeOpen: () => chromeOpen(panelOpen.current),
  });

  const status = q.error instanceof ApiClientError ? q.error.status : null;
  // A 404 or 403 after the artifact was on screen is the gone state, not a
  // new page: confirm it (the access check), and keep the copy meanwhile.
  const lost = (status === 404 || status === 403) && last.current !== undefined;
  const check = live.check;
  useEffect(() => {
    if (lost) void check();
  }, [lost, check]);
  const authed = me.status === "authed";
  // Signed out mid-visit (a 401 anywhere): only a public artifact stays viewable.
  const wasAuthed = useRef(false);
  if (authed) wasAuthed.current = true;
  const expired =
    wasAuthed.current &&
    me.status === "anonymous" &&
    data?.visibility !== "public";
  const toLogin =
    expired ||
    status === 401 ||
    (status === 404 &&
      !lost &&
      (me.status === "anonymous" || me.status === "error"));
  useLoginRedirect(toLogin, chromeless ? fullPath(id) : viewerPath(id, v));
  // A private artifact's title is shown only to a signed-in viewer.
  useDocumentTitle(
    data && (authed || data.visibility !== "private") ? data.title : null,
  );

  // Framed, never a sign-in redirect (useLoginRedirect is inert there).
  if (isEmbed() && !lost && (toLogin || status === 404 || status === 403))
    return <NotPublic id={id} />;
  if (toLogin) return null;
  if (status === 404 && authed && !lost) return <NotFound />;
  if (q.error && !data) return <ErrorPanel onRetry={() => void q.refetch()} />;
  if (!data || me.status === "loading")
    return <div className="oa-viewer" aria-busy="true" />;
  const version = v ?? live.shown ?? data.currentVersion;
  shownRef.current = version;
  const preload = live.preload?.version;
  const newer = live.latest > (v ?? preload ?? version);
  const layers = [
    ...(live.leaving !== null && live.leaving !== version
      ? [live.leaving]
      : []),
    version,
    ...(preload !== undefined && preload !== version ? [preload] : []),
  ];
  const slot = chromeless ? (
    <FullLive
      id={id}
      title={data.title}
      embed={embed}
      held={live.held}
      swapped={live.swapped}
      onView={live.view}
      onExpire={live.clearSwapped}
    />
  ) : (
    <TitleLive
      held={live.held}
      swapped={live.swapped}
      current={v !== undefined && live.latest > v ? live.latest : null}
      onView={live.view}
      onUndo={() => {
        const prev = live.swapped?.prev;
        if (prev !== undefined) void navigate({ to: viewerPath(id, prev) });
      }}
      onCurrent={() => void navigate({ to: viewerPath(id) })}
      onExpire={live.clearSwapped}
    />
  );
  return (
    <div className="oa-vstack">
      {layers.map((n) => {
        const shown = n === version;
        return (
          <div
            // New id/version remounts everything, so a new document never inherits the old bridge.
            key={`${data.id}:${n}`}
            className="oa-vlayer"
            data-preload={n === preload}
            data-arrived={shown && live.leaving !== null}
            inert={!shown}
            aria-hidden={shown ? undefined : true}
          >
            <Viewer
              artifact={data}
              version={n}
              explicitVersion={v !== undefined}
              chromeless={chromeless}
              authed={authed}
              role={authed ? me.me.user.role : undefined}
              plan={authed ? me.me.instance.plan : undefined}
              viewer={
                authed
                  ? { email: me.me.user.email, name: me.me.user.name }
                  : null
              }
              slot={shown ? slot : undefined}
              newer={shown && newer}
              gone={live.gone}
              onFrame={(s) => frames.current.set(n, s)}
              onReady={() => live.ready(n)}
              onTouched={shown ? live.touched : undefined}
              onAccessLost={live.check}
              onUndelete={live.undelete}
            />
          </div>
        );
      })}
      <LiveAnnouncer text={live.announcement} />
    </div>
  );
}
