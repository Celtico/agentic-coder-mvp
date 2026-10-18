import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage, ElectronWebviewTag, ProjectInfo, VerifiedExperience } from '../types';
import {
  Badge, Box, Button, Flex, Grid, Heading, HStack, Input, Stack,
  Spinner, Splitter, Text, Textarea
} from '@chakra-ui/react';
import {
  LuArrowLeft as ArrowLeft, LuArrowRight as ArrowRight, LuCheck as Check,
  LuExternalLink as ExternalLink, LuFolderOpen as FolderOpen, LuGlobe as Globe2,
  LuMessageSquarePlus as MessageSquarePlus, LuPanelLeftClose as PanelLeftClose, LuPanelLeftOpen as PanelLeftOpen,
  LuPlay as Play, LuRefreshCw as RefreshCw,
  LuSend as Send, LuTerminal as TerminalIcon, LuX as X
} from 'react-icons/lu';
import type { IconType } from 'react-icons';

const CHAT_KEY = 'agentic-chat-history-v1';
const DRAFT_KEY = 'agentic-chat-draft-v1';
const CHAT_SESSIONS_KEY = 'agentic-chat-sessions-v1';
const ACTIVE_SESSION_KEY = 'agentic-active-session-v1';
const SPLIT_KEY = 'agentic-split-size-v1';
const NAVIGATION_WIDTH_KEY = 'agentic-navigation-width-v1';
type ChatSession = { id: string; title: string; updatedAt: string; messages: ChatMessage[] };
type WorkspacePanel = 'browser' | 'terminal' | 'editor';

function makeSession(messages: ChatMessage[] = [], title = 'Conversa nova'): ChatSession {
  const prompt = messages.find((message) => message.role === 'user')?.text.trim();
  return {
    id: globalThis.crypto?.randomUUID?.() || `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: prompt ? (prompt.length > 42 ? `${prompt.slice(0, 39)}…` : prompt) : title,
    updatedAt: new Date().toISOString(),
    messages: messages.slice(-100),
  };
}

function getStoredSessions(): ChatSession[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CHAT_SESSIONS_KEY) || 'null');
    if (Array.isArray(value)) {
      const sessions = (value as ChatSession[]).filter((session) => session && typeof session.id === 'string' && Array.isArray(session.messages));
      if (sessions.length) return sessions.slice(0, 50);
    }
  } catch {}
  // Importa l'historial antic sense esborrar-ne la clau original: queda com a còpia recuperable.
  try {
    const legacy: unknown = JSON.parse(localStorage.getItem(CHAT_KEY) || '[]');
    if (Array.isArray(legacy) && legacy.length) {
      const session = makeSession(legacy as ChatMessage[], 'Conversa anterior');
      localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify([session]));
      return [session];
    }
  } catch {}
  const session = makeSession();
  localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify([session]));
  return [session];
}

type IconButtonProps = React.ComponentProps<typeof Button> & { icon: IconType; label: string };
const IconButton = ({ icon: Icon, label, ...props }: IconButtonProps) => <Button aria-label={label} title={label} variant="ghost" size="sm" px="2" {...props}><Icon size={16}/></Button>;
const IconLabel = ({ icon: Icon, children }: { icon: IconType; children: React.ReactNode }) => <HStack gap="2"><Icon size={16}/><span>{children}</span></HStack>;
type SplitterHandleId = React.ComponentProps<typeof Splitter.ResizeTrigger>['id'];
const SplitterHandle = ({ id }: { id: SplitterHandleId }) => (
  <Splitter.ResizeTrigger id={id} aria-label="Arrossega per ajustar l’amplada del panell" title="Arrossega per ajustar l’amplada del panell" w="12px" flex="none" cursor="col-resize" bg="transparent" _hover={{ bg: 'transparent' }} _focusVisible={{ outlineColor: 'border', outlineWidth: '1px' }}>
    <Splitter.ResizeTriggerSeparator bg="transparent"/>
    <Splitter.ResizeTriggerIndicator w="2px" h="32px" bg="border" borderWidth="0" boxShadow="none"/>
  </Splitter.ResizeTrigger>
);

function getSplitSize(): number[] {
  try { const value = JSON.parse(localStorage.getItem(SPLIT_KEY) || 'null'); return Array.isArray(value) && value.length === 2 ? value : [62, 38]; }
  catch { return [62, 38]; }
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function App(): React.JSX.Element {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>(getStoredSessions);
  const [activeSessionId, setActiveSessionId] = useState(() => {
    const available = getStoredSessions();
    const saved = localStorage.getItem(ACTIVE_SESSION_KEY);
    const active = available.some((session) => session.id === saved) ? saved! : available[0]!.id;
    localStorage.setItem(ACTIVE_SESSION_KEY, active);
    return active;
  });
  const activeSession = sessions.find((session) => session.id === activeSessionId) || sessions[0];
  const messages = activeSession?.messages || [];
  const [draft, setDraft] = useState(() => localStorage.getItem(`${DRAFT_KEY}:${activeSessionId}`) || localStorage.getItem(DRAFT_KEY) || '');
  const [status, setStatus] = useState('Preparat · model encara no carregat');
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState('Preparant el model local…');
  const [workspacePanel, setWorkspacePanel] = useState<WorkspacePanel | null>(null);
  const browserOpen = workspacePanel === 'browser';
  const [browserAddress, setBrowserAddress] = useState('');
  const [browserUrl, setBrowserUrl] = useState('about:blank');
  const [browserContext, setBrowserContext] = useState('');
  const [terminalCommand, setTerminalCommand] = useState('');
  const [terminalOutput, setTerminalOutput] = useState('');
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [terminalStatus, setTerminalStatus] = useState('');
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [editorOriginal, setEditorOriginal] = useState('');
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorStatus, setEditorStatus] = useState('');
  const [splitSize, setSplitSize] = useState(getSplitSize);
  const lastExpandedSplitSizeRef = useRef(splitSize);
  const [navigationOpen, setNavigationOpen] = useState(true);
  const [navigationWidth, setNavigationWidth] = useState(() => {
    const stored = Number(localStorage.getItem(NAVIGATION_WIDTH_KEY));
    return Number.isFinite(stored) && stored >= 220 && stored <= 360 ? stored : 252;
  });
  const [verifiedExperienceKeys, setVerifiedExperienceKeys] = useState<Set<string>>(() => new Set());
  const feedRef = useRef<HTMLDivElement | null>(null);
  const hasInitialScrollRef = useRef(false);
  const previousSessionIdRef = useRef(activeSessionId);
  const webviewRef = useRef<ElectronWebviewTag | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const persistMessages = useCallback((next: ChatMessage[], sessionId = activeSessionId) => {
    const trimmed = next.slice(-100);
    setSessions((current) => {
      const existing = current.find((session) => session.id === sessionId);
      const prompt = trimmed.find((message) => message.role === 'user')?.text.trim();
      const updated = existing
        ? { ...existing, title: existing.title === 'Conversa nova' && prompt ? (prompt.length > 42 ? `${prompt.slice(0, 39)}…` : prompt) : existing.title, updatedAt: new Date().toISOString(), messages: trimmed }
        : makeSession(trimmed);
      const nextSessions = [updated, ...current.filter((session) => session.id !== sessionId)].slice(0, 50);
      localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(nextSessions));
      return nextSessions;
    });
  }, [activeSessionId]);

  useEffect(() => {
    const offStatus = window.agentic.onStatus((s) => {
      const text = s.message || s.type;
      setStatus(text);
      if (text) setLoadingLabel(text);
    });
    const offTerminal = window.agentic.onTerminalOutput((chunk: string) => setTerminalOutput((prev) => (prev + chunk).slice(-100000)));
    let cancelled = false;
    (async () => {
      if (localStorage.getItem(CHAT_KEY) === null) {
        try {
          const entries = await window.agentic.recentHistory();
          if (!cancelled && entries?.length) persistMessages(entries.flatMap((entry) => [
            { role: 'user', text: entry.prompt }, { role: 'assistant', text: entry.answer }
          ]));
        } catch {}
      }
      try { const saved = await window.agentic.currentProject(); if (!cancelled && saved) setProject(saved); }
      catch {}
    })();
    return () => { cancelled = true; offStatus?.(); offTerminal?.(); };
  }, [persistMessages]);

  useEffect(() => { localStorage.setItem(`${DRAFT_KEY}:${activeSessionId}`, draft); }, [draft, activeSessionId]);
  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (!feed) return;
    const firstRender = !hasInitialScrollRef.current;
    const changedSession = previousSessionIdRef.current !== activeSessionId;
    if (firstRender || changedSession) {
      feed.scrollTop = feed.scrollHeight;
      hasInitialScrollRef.current = true;
      previousSessionIdRef.current = activeSessionId;
      return;
    }
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 160;
    if (nearBottom) feed.scrollTop = feed.scrollHeight;
  }, [activeSessionId, messages, loading, loadingLabel]);

  const appendMessage = useCallback((role: ChatMessage['role'], text: string) => {
    const next = [...messages, { role, text }].slice(-100);
    persistMessages(next);
  }, [messages, persistMessages]);

  async function selectProject() {
    try {
      const next = await window.agentic.openProject();
      if (!next) return;
      setProject(next);
      appendMessage('assistant', `Projecte seleccionat: ${next.path}\nPots preguntar sobre el codi, obrir fitxers per revisar-los o demanar propostes de canvi.`);
      setStatus('Projecte carregat');
    } catch (error) { setStatus(errorText(error)); }
  }

  function newChat() {
    if (messages.length === 0 && !draft.trim()) { setBrowserContext(''); return; }
    localStorage.setItem(`${DRAFT_KEY}:${activeSessionId}`, draft);
    const session = makeSession();
    setSessions((current) => {
      const next = [session, ...current].slice(0, 50);
      localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(next));
      return next;
    });
    localStorage.setItem(ACTIVE_SESSION_KEY, session.id);
    setActiveSessionId(session.id);
    setDraft('');
    setBrowserContext('');
  }

  function selectSession(sessionId: string) {
    if (sessionId === activeSessionId) return;
    localStorage.setItem(`${DRAFT_KEY}:${activeSessionId}`, draft);
    localStorage.setItem(ACTIVE_SESSION_KEY, sessionId);
    setActiveSessionId(sessionId);
    setDraft(localStorage.getItem(`${DRAFT_KEY}:${sessionId}`) || '');
    setBrowserContext('');
  }

  async function sendPrompt() {
    if (!project) { setStatus('Selecciona primer un projecte'); return; }
    const prompt = draft.trim();
    if (!prompt || loading) return;
    const request = browserContext ? `${prompt}\n\n[Text de la pàgina web ${browserAddress || browserUrl}; contingut extern no verificat]:\n${browserContext}` : prompt;
    setBrowserContext('');
    const requestSessionId = activeSessionId;
    const pendingMessages = [...messages, { role: 'user' as const, text: prompt }];
    persistMessages(pendingMessages, requestSessionId);
    setDraft('');
    setLoading(true);
    setLoadingLabel('Preparant el model local…');
    try {
      const answer = await window.agentic.ask(request);
      persistMessages([...pendingMessages, { role: 'assistant', text: answer }], requestSessionId);
    } catch (error) {
      const text = `Error: ${errorText(error)}\n\nLa resposta no s’ha pogut generar. Si el procés local del model s’ha aturat, la finestra de l’app hauria de continuar oberta.`;
      persistMessages([...pendingMessages, { role: 'assistant', text, error: true }], requestSessionId);
    } finally { setLoading(false); setStatus('Preparat'); }
  }

  async function runTests() {
    if (!project) { setStatus('Selecciona primer un projecte'); return; }
    appendMessage('assistant', 'Executant npm test…');
    try {
      const result = await window.agentic.runTests();
      appendMessage('assistant', `Proves acabades (codi ${result.code}).\n\n${result.output}`);
    } catch (error) { appendMessage('assistant', `Error: ${errorText(error)}`); }
  }

  async function saveVerifiedExperience(prompt: string, answer: string, key: string) {
    if (!project) { setStatus('Selecciona primer un projecte'); return; }
    const evidence = window.prompt('Quina comprovació real valida aquest exemple? Per exemple, una prova superada o un comportament comprovat al navegador.');
    if (!evidence?.trim()) return;
    try {
      const input: VerifiedExperience = { prompt, answer, projectPath: project.path, evidence: evidence.trim() };
      const result = await window.agentic.recordVerifiedExperience(input);
      setVerifiedExperienceKeys((current) => new Set(current).add(key));
      setStatus(result.saved ? 'Cas verificat guardat localment; el model no s’ha entrenat.' : 'Aquest cas ja era a la memòria local.');
    } catch (error) {
      const message = errorText(error);
      if (!message.includes('cancel·lat')) setStatus(message);
    }
  }

  async function openEditor(relativePath: string) {
    try {
      const content = await window.agentic.readFile(relativePath);
      setEditingPath(relativePath); setEditorOriginal(content); setEditorContent(content); setEditorStatus(''); setWorkspacePanel('editor');
    } catch (error) { appendMessage('assistant', `No s’ha pogut obrir el fitxer: ${errorText(error)}`); }
  }

  async function saveEdit() {
    if (!editingPath) return;
    if (editorContent === editorOriginal) { setEditorStatus('No hi ha canvis.'); return; }
    if (!window.confirm(`Desar els canvis a ${editingPath}?`)) return;
    setEditorBusy(true);
    try {
      const saved = await window.agentic.writeFile(editingPath, editorContent);
      setEditorOriginal(editorContent); setEditingPath(null); setWorkspacePanel(null);
      appendMessage('assistant', `Canvi desat a ${editingPath}.\nCòpia de seguretat local: ${saved.backupPath}`);
    } catch (error) { setEditorStatus(errorText(error)); }
    finally { setEditorBusy(false); }
  }

  async function navigateBrowser() {
    let raw = browserAddress.trim(); if (!raw) return;
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    try {
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      setBrowserAddress(url.href); setBrowserUrl(url.href);
    } catch { setStatus('Adreça web no vàlida'); }
  }

  async function usePageContext() {
    try {
      const page = await webviewRef.current?.executeJavaScript('JSON.stringify({url:location.href,title:document.title,text:document.body?document.body.innerText:""})');
      const data = JSON.parse(page || '{}');
      const text = String(data.text || '').slice(0, 12000);
      setBrowserContext(`URL: ${data.url || browserAddress}\nTítol: ${data.title || ''}\n\n${text}`);
      setWorkspacePanel(null);
      setStatus(text ? 'Pàgina afegida al context del xat' : 'La pàgina no conté text visible');
      promptRef.current?.focus();
    } catch (error) { setStatus(`No s’ha pogut llegir la pàgina: ${errorText(error)}`); }
  }

  async function executeCommand() {
    const command = terminalCommand.trim();
    if (!command || !project || terminalBusy) return;
    setTerminalOutput((current) => `${current}\n$ ${command}\n`);
    setTerminalStatus('Esperant confirmació…');
    setTerminalBusy(true);
    try {
      const result = await window.agentic.runCommand(command);
      setTerminalStatus(result.code === null ? 'Ordre cancel·lada.' : `Procés acabat amb codi ${result.code}.`);
      if (result.code === null && result.output) setTerminalOutput((current) => `${current}${result.output}\n`);
    } catch (error) { const message = errorText(error); setTerminalStatus(message); setTerminalOutput((current) => `${current}\n${message}\n`); }
    finally { setTerminalBusy(false); }
  }

  const chatPane = (
    <Flex h="full" minW="0" minH="0" direction="column" bg="bg">
      <Flex h="58px" flex="none" borderBottomWidth="1px" borderColor="border" px="5" align="center" justify="space-between" gap="3">
        <Heading size="sm" fontWeight="500">Agentic Coder</Heading>
        <Text color="fg.muted" fontSize="xs" maxW="320px" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">{status}</Text>
      </Flex>
      <Box ref={feedRef} flex="1" minH="0" overflowY="auto" overscrollBehavior="contain" px="max(24px, calc((100% - 820px) / 2))" py="8" css={{ scrollbarGutter: "stable" }}>
        {!messages.length ? <Box maxW="740px" mx="auto" mt="11vh" textAlign="center"><Heading size="2xl" fontWeight="medium">En què treballem?</Heading><Text color="fg.muted" mt="3" mb="5">Tria la carpeta del projecte i descriu què vols entendre o millorar.</Text><Badge colorPalette="agentic" variant="subtle">Qwen2.5-Coder-1.5B-Instruct · model local</Badge></Box> : <Stack maxW="820px" mx="auto" gap="6">{messages.map((message, index) => {
          const previousUser = message.role === 'assistant' ? [...messages.slice(0, index)].reverse().find((item) => item.role === 'user') : undefined;
          const experienceKey = `${activeSessionId}:${index}`;
          return <Box key={`${index}-${message.role}`} textStyle="chatMessage" alignSelf={message.role === 'user' ? 'flex-end' : 'stretch'} bg={message.role === 'user' ? 'surface' : 'transparent'} borderRadius={message.role === 'user' ? '20px' : '0'} px={message.role === 'user' ? '4' : '2'} py={message.role === 'user' ? '3' : '0'} maxW={message.role === 'user' ? '82%' : '100%'} whiteSpace="pre-wrap" overflowWrap="anywhere" color={message.error ? 'red.200' : 'fg'}>
            {message.text}
            {previousUser && !message.error && <Button mt="2" size="xs" variant="ghost" colorPalette="gray" disabled={verifiedExperienceKeys.has(experienceKey)} onClick={() => void saveVerifiedExperience(previousUser.text, message.text, experienceKey)}>{verifiedExperienceKeys.has(experienceKey) ? 'Desat com a cas verificat' : 'Desa com a cas verificat…'}</Button>}
          </Box>;
        })}</Stack>}
        {loading && <HStack gap="2.5" color="fg.muted" px="2" py="1"><Spinner size="sm" colorPalette="agentic"/><Text>{loadingLabel}</Text></HStack>}
      </Box>
      <Box flex="none" w="min(850px, calc(100% - 40px))" mx="auto" mb="4">
        {browserContext && <Flex align="center" justify="space-between" mb="2" px="2"><Text fontSize="xs" color="agentic.200">Text d’una pàgina web afegit al context</Text><IconButton icon={X} label="Treu el context web" onClick={() => setBrowserContext('')}/></Flex>}
        <Box bg="surface" borderWidth="1px" borderColor="border" borderRadius="22px" p="3" boxShadow="composer">
          <Textarea ref={promptRef} value={draft} onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value)} onKeyDown={(event: React.KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendPrompt(); } }} placeholder="Pregunta sobre el projecte o descriu una millora…" minH="64px" maxH="190px" resize="vertical" variant="outline" bg="transparent" color="fg" border="0" textStyle="chatMessage" _focusVisible={{ boxShadow: "none" }}/>
          <Flex mt="2" align="center" justify="space-between" gap="3">
            <HStack gap="2"><Button size="xs" variant="outline" onClick={runTests}><IconLabel icon={Play}>Executa proves</IconLabel></Button><Text fontSize="xs" color="fg.muted">Les proves només s’executen quan tu ho demanes.</Text></HStack>
            <Button aria-label="Envia" title="Envia" colorPalette="agentic" rounded="full" size="sm" onClick={sendPrompt} disabled={loading}><Send size={17}/></Button>
          </Flex>
        </Box>
        <Text fontSize="xs" color="fg.muted" textAlign="center" mt="2">Les respostes poden contenir errors. Revisa els suggeriments abans d’aplicar-los.</Text>
      </Box>
    </Flex>
  );

  const browserPane = (
    <Flex h="full" w="full" minW="0" direction="column" bg="bg">
      <Flex gap="1.5" align="center" p="2" borderBottomWidth="1px" borderColor="border" flexWrap="wrap">
        <IconButton icon={ArrowLeft} label="Enrere" onClick={() => { if (webviewRef.current?.canGoBack()) webviewRef.current.goBack(); }}/>
        <IconButton icon={ArrowRight} label="Endavant" onClick={() => { if (webviewRef.current?.canGoForward()) webviewRef.current.goForward(); }}/>
        <IconButton icon={RefreshCw} label="Recarrega" onClick={() => webviewRef.current?.reload()}/>
        <Input flex="1" minW="110px" bg="surface.subtle" color="fg" value={browserAddress} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setBrowserAddress(event.target.value)} onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') navigateBrowser(); }} placeholder="https://…" size="sm"/>
        <IconButton icon={ExternalLink} label="Ves a l’adreça" size="sm" colorPalette="agentic" onClick={navigateBrowser}/>
        <Button size="sm" variant="outline" onClick={usePageContext} disabled={browserUrl === 'about:blank'}>Afegeix pàgina al xat</Button>
      </Flex>
      {browserUrl === 'about:blank'
        ? <Box flex="1" minH="0" bg="bg"/>
        : <webview ref={webviewRef} src={browserUrl} partition="persist:agentic-browser" webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes" style={{ display: 'flex', flex: 1, width: '100%', height: '100%', minHeight: 0, border: 0, background: '#212121' }}/>}
    </Flex>
  );

  const terminalPane = (
    <Flex h="full" minH="0" direction="column" p="4" bg="bg">
      <Text fontSize="xs" color="fg.muted" mb="2">{project?.path}</Text>
      <Textarea flex="1" minH="0" resize="none" bg="surface.subtle" color="agentic.100" fontFamily="mono" fontSize="xs" lineHeight="1.6" whiteSpace="pre-wrap" value={terminalOutput} readOnly placeholder="La sortida de les ordres apareixerà aquí"/>
      <HStack mt="3"><Input value={terminalCommand} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setTerminalCommand(event.target.value)} onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') executeCommand(); }} placeholder="Ex.: npm run check"/><IconButton icon={Play} label="Executa l’ordre" colorPalette="agentic" onClick={executeCommand} disabled={terminalBusy || !terminalCommand.trim()}>{terminalBusy && <Spinner size="sm"/>}</IconButton></HStack>
      <Text fontSize="xs" color="yellow.200" mt="2">Les ordres s’executen dins del projecte i poden modificar o esborrar fitxers.</Text>
      <Text fontSize="xs" color="fg.muted" mt="2">{terminalStatus}</Text>
    </Flex>
  );

  const editorPane = (
    <Flex h="full" minH="0" direction="column" p="4" bg="bg">
      <Text color="fg.muted" mb="3">Revisa els canvis abans de desar. Si el projecte està sota Git, pots guardar-los amb un commit.</Text>
      <Textarea flex="1" minH="0" resize="none" bg="surface.subtle" color="fg" fontFamily="mono" fontSize="xs" lineHeight="1.6" value={editorContent} onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setEditorContent(event.target.value)} spellCheck={false}/>
      <Text color="yellow.200" mt="2">{editorStatus}</Text>
      <HStack justify="flex-end" mt="3"><Button variant="outline" onClick={() => { setEditingPath(null); setWorkspacePanel(null); }}>Cancel·la</Button><Button colorPalette="agentic" onClick={saveEdit} disabled={editorBusy}>{editorBusy ? <Spinner size="sm"/> : <Check size={16}/>}Desa el canvi</Button></HStack>
    </Flex>
  );

  useEffect(() => {
    const view = webviewRef.current;
    if (!view) return;
    const updateAddress = (event: Event) => { const url = (event as Event & { url?: string }).url; if (url) setBrowserAddress(url); };
    view.addEventListener('did-navigate', updateAddress);
    view.addEventListener('did-navigate-in-page', updateAddress);
    return () => { view.removeEventListener('did-navigate', updateAddress); view.removeEventListener('did-navigate-in-page', updateAddress); };
  }, [browserOpen, browserUrl]);

  const panelTitle = workspacePanel === 'browser' ? 'Navegador web' : workspacePanel === 'terminal' ? 'Terminal del projecte' : 'Edita fitxer';
  const panelContent = workspacePanel === 'browser' ? browserPane : workspacePanel === 'terminal' ? terminalPane : workspacePanel === 'editor' ? editorPane : null;
  const workspacePane = panelContent && (
    <Flex h="full" minW="0" minH="0" direction="column" bg="bg" borderLeftWidth="1px" borderColor="border">
      <Flex h="58px" flex="none" align="center" justify="space-between" px="3.5" borderBottomWidth="1px" borderColor="border">
        <HStack gap="2"><Text fontWeight="semibold">{panelTitle}</Text>{workspacePanel === 'terminal' && <Badge colorPalette="yellow">Cada ordre demana confirmació</Badge>}{workspacePanel === 'editor' && <Badge colorPalette="agentic">Revisa abans de desar</Badge>}</HStack>
        <IconButton icon={X} label="Tanca panell" onClick={() => { setWorkspacePanel(null); if (workspacePanel === 'editor') setEditingPath(null); }}/>
      </Flex>
      <Box flex="1" minH="0" overflow="hidden">{panelContent}</Box>
    </Flex>
  );

  const mainContent = workspacePanel && workspacePane ? (
    <Splitter.Root h="full" w="full" display="flex" overflow="hidden" orientation="horizontal" panels={[{ id: 'chat', minSize: 35 }, { id: 'workspace', minSize: 8 }]} defaultSize={splitSize} onResize={(details) => setSplitSize(details.size)} onResizeEnd={(details) => {
      if (details.size[1] <= 12) {
        setWorkspacePanel(null);
        setSplitSize(lastExpandedSplitSizeRef.current);
        localStorage.setItem(SPLIT_KEY, JSON.stringify(lastExpandedSplitSizeRef.current));
        return;
      }
      lastExpandedSplitSizeRef.current = details.size;
      setSplitSize(details.size);
      localStorage.setItem(SPLIT_KEY, JSON.stringify(details.size));
    }}>
      <Splitter.Panel id="chat" h="full" minW="0" minH="0" overflow="hidden">{chatPane}</Splitter.Panel>
      <SplitterHandle id="chat:workspace"/>
      <Splitter.Panel id="workspace" h="full" minW="0" minH="0" overflow="hidden">{workspacePane}</Splitter.Panel>
    </Splitter.Root>
  ) : chatPane;

  return (
    <Grid h="100dvh" w="100vw" minW="0" templateColumns="64px minmax(0, 1fr)" overflow="hidden" bg="bg" textStyle="interface">
        <Flex as="nav" aria-label="Accions principals" h="full" minH="0" bg="surface.subtle" borderRightWidth="1px" borderColor="border" px="2" direction="column" align="center" gap="2">
          <Flex h="58px" w="full" flex="none" align="center" justify="center" borderBottomWidth="1px" borderColor="border" fontSize="2xl" fontWeight="bold" color="agentic.300" title="Agentic Coder">◈</Flex>
          <IconButton icon={navigationOpen ? PanelLeftClose : PanelLeftOpen} label={navigationOpen ? 'Amaga converses i fitxers' : 'Mostra converses i fitxers'} w="44px" h="44px" variant={navigationOpen ? 'subtle' : 'ghost'} colorPalette={navigationOpen ? 'agentic' : 'gray'} onClick={() => setNavigationOpen((open) => !open)}/>
          <IconButton icon={MessageSquarePlus} label="Nova conversa" w="44px" h="44px" onClick={newChat}/>
          <IconButton icon={FolderOpen} label="Selecciona projecte" w="44px" h="44px" onClick={selectProject}/>
          <IconButton icon={Globe2} label={workspacePanel === 'browser' ? 'Tanca el navegador' : 'Obre el navegador'} w="44px" h="44px" variant={workspacePanel === 'browser' ? 'subtle' : 'ghost'} colorPalette={workspacePanel === 'browser' ? 'agentic' : 'gray'} onClick={() => setWorkspacePanel((current) => current === 'browser' ? null : 'browser')}/>
          <IconButton icon={TerminalIcon} label={workspacePanel === 'terminal' ? 'Tanca la terminal del projecte' : 'Obre la terminal del projecte'} w="44px" h="44px" variant={workspacePanel === 'terminal' ? 'subtle' : 'ghost'} colorPalette={workspacePanel === 'terminal' ? 'agentic' : 'gray'} onClick={() => { if (!project) setStatus('Selecciona primer un projecte'); else setWorkspacePanel((current) => current === 'terminal' ? null : 'terminal'); }}/>
        </Flex>
        {navigationOpen ? <Splitter.Root key="navigation-open" h="full" w="full" minW="0" display="flex" overflow="hidden" orientation="horizontal" panels={[{ id: 'navigation', minSize: '220px', maxSize: '360px', resizeBehavior: 'preserve-pixel-size' }, { id: 'main', minSize: '440px' }]} defaultSize={[`${navigationWidth}px`]} onResizeEnd={(details) => {
          const availableWidth = Math.max(660, window.innerWidth - 64);
          const width = Math.max(220, Math.min(360, Math.round((details.size[0] / 100) * availableWidth)));
          setNavigationWidth(width);
          localStorage.setItem(NAVIGATION_WIDTH_KEY, String(width));
        }}>
        <Splitter.Panel id="navigation" h="full" minW="0" minH="0" overflow="hidden">
        <Flex as="aside" h="full" minH="0" minW="0" bg="surface.subtle" borderRightWidth="1px" borderColor="border" px="3" direction="column" gap="3">
          <Flex h="58px" flex="none" align="center" borderBottomWidth="1px" borderColor="border" px="2" fontWeight="semibold">Espai de treball</Flex>
          {sessions.some((session) => session.messages.length > 0) && <Box flex="none" maxH="24vh" minH="0" overflowY="auto">
            <Text px="2" pt="2" pb="1" color="fg.muted" fontSize="2xs" textTransform="uppercase" letterSpacing="0.1em">Converses recents</Text>
            <Stack gap="0.5">{sessions.filter((session) => session.messages.length > 0).slice(0, 12).map((session) => <Button key={session.id} size="sm" w="full" minW="0" justifyContent="flex-start" textAlign="left" variant={session.id === activeSessionId ? 'subtle' : 'ghost'} colorPalette={session.id === activeSessionId ? 'agentic' : 'gray'} overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap" title={session.title} onClick={() => selectSession(session.id)}>{session.title}</Button>)}</Stack>
          </Box>}
          <Text fontSize="xs" color="fg.muted" overflowWrap="anywhere" px="2" py="0.5" minH="5" title={project?.path}>{project?.path || 'Cap projecte seleccionat'}</Text>
          <Box flex="1" minH="0" overflowY="auto"><Text px="2" pt="3" pb="1.5" color="fg.muted" fontSize="2xs" textTransform="uppercase" letterSpacing="0.1em">Fitxers del projecte</Text>{project?.files?.filter((file) => !file.directory).map((file) => <Button key={file.path} w="full" justifyContent="flex-start" variant="ghost" size="sm" whiteSpace="nowrap" overflow="hidden" textOverflow="ellipsis" fontSize="xs" onClick={() => openEditor(file.path)}>{file.path}</Button>)}</Box>
          <Box fontSize="xs" color="fg.muted" p="2" lineHeight="1.6">Model local Qwen · Transformers.js<br/>El model s’executa al Mac.</Box>
        </Flex>
        </Splitter.Panel>
        <SplitterHandle id={'navigation:main' as SplitterHandleId}/>
        <Splitter.Panel id="main" h="full" minW="0" minH="0" overflow="hidden">{mainContent}</Splitter.Panel>
        </Splitter.Root> : <Box h="full" minW="0" minH="0" overflow="hidden">{mainContent}</Box>}
    </Grid>
  );
}

