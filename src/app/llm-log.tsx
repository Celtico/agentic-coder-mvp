import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react"
import { Accordion, Badge, Box, Button, chakra, Grid, HStack, Progress, Spinner, Stack, Switch, Tabs, Text } from "@chakra-ui/react"
import { LuCopy as Copy, LuFolderOpen as FolderOpen, LuRefreshCw as RefreshCw, LuScrollText as ScrollText, LuTrash2 as Trash } from "react-icons/lu"
import type { LlmCallRecord, LlmToolRecord, LlmTraceEvent } from "../core/assistant/llm-trace"
import { Pane, PaneHeader, PaneToolbar } from "./pane-header"
import { scrollArea } from "../theme/scroll-area"

/**
 * Log del model: each call to the model, newest first — what went in (the final prompt after the chat
 * template, and its parts with their tokens), the parameters, what came out (raw, and what the app read
 * in it), the tools run after it and the figures. It only watches (src/core/assistant/llm-trace.ts):
 * the recording is on while this panel is open, and nothing of it goes to the history or the training.
 */
export type LlmCall = LlmCallRecord & { tools: LlmToolRecord[] }
type Live = { id: string; source: string; model: string; text: string }

const PANE_ACCORDION = "pane" as unknown as "plain"
const mono = { fontFamily: "mono", fontSize: "xs", whiteSpace: "pre-wrap", overflowWrap: "anywhere", bg: "bg.subtle", borderRadius: "md", px: "2", py: "1.5", maxH: "80", ...scrollArea } as const
const number = (value: number | null | undefined, suffix = "") => value === null || value === undefined ? "—" : `${value.toLocaleString("ca")}${suffix}`
const sourcePalette = (source: string) => source === "revisor" ? "purple" : source.startsWith("avalua") || source.startsWith("benchmark") ? "orange" : source === "agent delegat" ? "blue" : "agentic"
const errorMessage = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error)

/** A token coloured by how sure the model was of it; the five likeliest at that step on hover. */
const confidence = (p: number) => p >= 0.9 ? {} : p >= 0.5 ? { bg: "yellow.subtle", color: "yellow.fg" } : { bg: "red.subtle", color: "red.fg" }
function TokenView({ tokens }: { tokens: NonNullable<LlmCallRecord["output"]["tokens"]> }) {
  return <Box {...mono} lineHeight="tall">{tokens.map((token, index) => <chakra.span key={index} borderRadius="xs" {...confidence(token.p)}
    title={`${(token.p * 100).toFixed(1)} %\n${token.top.map(([text, p]) => `${JSON.stringify(text)}  ${(p * 100).toFixed(1)} %`).join("\n")}`}>{token.t}</chakra.span>)}</Box>
}

const Label = ({ children }: { children: ReactNode }) => <Text fontSize="2xs" color="fg.muted" textTransform="uppercase" letterSpacing="wider" mb="1">{children}</Text>

function CallDetail({ call }: { call: LlmCall }) {
  const { input, output, metrics, params } = call
  const used = input.promptTokens ?? metrics.promptTokens
  return <Tabs.Root size="sm" variant="line" defaultValue="input" lazyMount>
    <Tabs.List><Tabs.Trigger value="input">Entrada</Tabs.Trigger><Tabs.Trigger value="params">Paràmetres</Tabs.Trigger><Tabs.Trigger value="output">Sortida</Tabs.Trigger><Tabs.Trigger value="tools">Eines {call.tools.length > 0 && <Badge size="xs">{call.tools.length}</Badge>}</Tabs.Trigger><Tabs.Trigger value="metrics">Mètriques</Tabs.Trigger></Tabs.List>
    <Tabs.Content value="input"><Stack gap="3">
      {used !== null && input.context && <Box>
        <HStack justify="space-between"><Label>Context</Label><Text fontSize="xs" color="fg.muted">{number(used)} de {number(input.context)} tokens</Text></HStack>
        <Progress.Root size="xs" colorPalette={used / input.context > 0.8 ? "red" : "agentic"} value={Math.min(100, Math.round(used / input.context * 100))}><Progress.Track><Progress.Range/></Progress.Track></Progress.Root>
      </Box>}
      {input.parts.length > 0 && <Box>
        <Label>Instruccions del sistema, per origen</Label>
        <Accordion.Root multiple collapsible size="sm" variant="enclosed">{input.parts.map((part, index) => <Accordion.Item key={index} value={String(index)}>
          <Accordion.ItemTrigger><HStack flex="1" gap="2" minW="0"><Text fontSize="xs" fontWeight="medium" truncate>{part.source}</Text>{part.source === "casos verificats recuperats" && <Badge size="xs" colorPalette="orange">recuperat</Badge>}</HStack><Text fontSize="xs" color="fg.muted">{number(part.tokens)} tokens</Text><Accordion.ItemIndicator/></Accordion.ItemTrigger>
          <Accordion.ItemContent><Accordion.ItemBody><Box {...mono}>{part.text}</Box></Accordion.ItemBody></Accordion.ItemContent>
        </Accordion.Item>)}</Accordion.Root>
      </Box>}
      <Box>
        <Label>Missatges</Label>
        <Accordion.Root multiple collapsible size="sm" variant="enclosed">{input.messages.map((message, index) => <Accordion.Item key={index} value={String(index)}>
          <Accordion.ItemTrigger><HStack flex="1" gap="2" minW="0"><Badge size="xs" variant="outline">{message.role}</Badge><Text fontSize="xs" color="fg.muted" truncate>{message.content.slice(0, 120)}</Text></HStack><Text fontSize="xs" color="fg.muted" flex="none">{number(message.tokens)} tokens</Text><Accordion.ItemIndicator/></Accordion.ItemTrigger>
          <Accordion.ItemContent><Accordion.ItemBody><Box {...mono}>{message.content}</Box></Accordion.ItemBody></Accordion.ItemContent>
        </Accordion.Item>)}</Accordion.Root>
      </Box>
      <Text fontSize="xs" color="fg.muted">Eines descrites: {input.tools.length ? `${input.tools.join(", ")} (${number(input.toolTokens)} tokens)` : "cap"}{input.images.length ? ` · Imatges: ${input.images.map((image) => `${image.path.split("/").pop()} (${image.bytes ? `${Math.round(image.bytes / 1024)} kB` : "?"})`).join(", ")}` : ""}</Text>
      <Box><Label>Prompt final, després de la plantilla del model</Label>{input.prompt ? <Box {...mono}>{input.prompt}</Box> : <Text fontSize="xs" color="fg.muted">No disponible.</Text>}</Box>
    </Stack></Tabs.Content>
    <Tabs.Content value="params">
      <Grid templateColumns="auto 1fr" columnGap="4" rowGap="1" fontSize="xs">
        {([["Model", call.model], ["Adaptador (beta)", call.adapter || "cap"], ["Motor", call.backend || "—"], ["Temperatura", String(params.temperature)], ["top_p", params.topP ?? "per defecte"], ["Màxim de tokens", number(params.maxTokens)], ["Seqüències d’aturada", params.stop.length ? params.stop.join(" · ") : "les del model"], ["Llavor", params.seed ?? "cap"], ["Probabilitats", params.logprobs ? "sí" : "no"]] as [string, ReactNode][]).map(([label, value]) => <Fragment key={label}><Text color="fg.muted">{label}</Text><Text fontFamily="mono" overflowWrap="anywhere">{value}</Text></Fragment>)}
      </Grid>
    </Tabs.Content>
    <Tabs.Content value="output"><Stack gap="3">
      {output.error && <Text fontSize="sm" color="fg.error">{output.error}</Text>}
      <HStack gap="2" fontSize="xs" color="fg.muted"><Text>Final: {output.finishReason === "stop" ? "el model ha acabat (EOS)" : output.finishReason === "length" ? "límit de tokens" : output.finishReason || "—"}</Text></HStack>
      {output.tokens?.length ? <Box><Label>Text generat, amb la seguretat de cada token</Label><TokenView tokens={output.tokens}/></Box>
        : <Box><Label>Text generat, tal com ha sortit</Label>{output.raw !== null ? <Box {...mono}>{output.raw}</Box> : <Text fontSize="xs" color="fg.muted">No disponible.</Text>}</Box>}
      <Box><Label>Crides d’eina que ha llegit l’app</Label>{output.toolCalls.length ? <Stack gap="1.5">{output.toolCalls.map((tool, index) => <Box key={index}><Text fontSize="xs" fontWeight="medium">{tool.name}</Text><Box {...mono}>{JSON.stringify(tool.arguments, null, 2)}</Box></Box>)}</Stack> : <Text fontSize="xs" color="fg.muted">Cap.</Text>}</Box>
      {output.parseErrors.length > 0 && <Box><Label>No s’han pogut llegir</Label>{output.parseErrors.map((error, index) => <Text key={index} fontSize="xs" color="fg.error">{error}</Text>)}</Box>}
      <Box><Label>Resposta (sense les crides)</Label>{output.answer ? <Box {...mono}>{output.answer}</Box> : <Text fontSize="xs" color="fg.muted">Cap text fora de les crides.</Text>}</Box>
    </Stack></Tabs.Content>
    <Tabs.Content value="tools">{call.tools.length ? <Stack gap="2">{call.tools.map((tool, index) => <Box key={index} borderWidth="1px" borderColor="border" borderRadius="md" px="2.5" py="2">
      <HStack gap="2"><Text fontSize="sm" fontWeight="medium" flex="1">{tool.name}</Text><Badge size="xs" colorPalette={tool.ok ? "green" : "red"}>{tool.ok ? "ok" : "error"}</Badge><Text fontSize="xs" color="fg.muted">{number(tool.ms, " ms")}</Text></HStack>
      <Label>Arguments</Label><Box {...mono}>{JSON.stringify(tool.arguments, null, 2)}</Box>
      <Box mt="2"><Label>Resultat, tal com torna al model</Label><Box {...mono}>{tool.result.length > 8000 ? `${tool.result.slice(0, 8000)}…` : tool.result}</Box></Box>
    </Box>)}</Stack> : <Text fontSize="xs" color="fg.muted">Després d’aquesta crida no s’ha executat cap eina.</Text>}</Tabs.Content>
    <Tabs.Content value="metrics">
      <Grid templateColumns="auto 1fr" columnGap="4" rowGap="1" fontSize="xs">
        {([["Càrrega del model", metrics.loadSeconds !== null ? number(metrics.loadSeconds, " s") : "ja era carregat"], ["Primer token", number(metrics.firstTokenSeconds, " s")], ["Tokens d’entrada", number(metrics.promptTokens)], ["Lectura de l’entrada", number(metrics.promptTps, " tok/s")], ["Tokens generats", number(metrics.generationTokens)], ["Generació", number(metrics.generationTps, " tok/s")], ["Memòria màxima", number(metrics.peakMemoryGb, " GB")], ["Durada total", number(metrics.seconds, " s")]] as [string, string][]).map(([label, value]) => <Fragment key={label}><Text color="fg.muted">{label}</Text><Text fontFamily="mono">{value}</Text></Fragment>)}
      </Grid>
    </Tabs.Content>
  </Tabs.Root>
}

export function LlmLogPane() {
  const [calls, setCalls] = useState<LlmCall[] | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [logprobs, setLogprobs] = useState(false)
  const [error, setError] = useState("")
  const [confirmClear, setConfirmClear] = useState(false)
  const reload = useCallback(async () => {
    try { setCalls((await window.agentic.listLlmCalls()).calls as LlmCall[]); setError("") } catch (caught) { setError(errorMessage(caught)) }
  }, [])
  // Recording is on while the panel is open, and off when it closes.
  useEffect(() => {
    void window.agentic.setLlmTrace({ open: true }).then((state) => setLogprobs(state.logprobs))
    void reload()
    const stop = window.agentic.onLlmEvent((event: LlmTraceEvent) => {
      if (event.type === "start") setLive({ id: event.id, source: event.source, model: event.model, text: "" })
      else if (event.type === "token") setLive((current) => current && current.id === event.id ? { ...current, text: current.text + event.text } : current)
      else if (event.type === "call") { setLive((current) => current?.id === event.call.id ? null : current); setCalls((current) => [{ ...event.call, tools: [] }, ...(current || [])].slice(0, 50)) }
      else if (event.type === "tool") setCalls((current) => current?.map((call) => call.id === event.tool.callId ? { ...call, tools: [...call.tools, event.tool] } : call) ?? current)
    })
    return () => { stop(); void window.agentic.setLlmTrace({ open: false }) }
  }, [reload])

  const toolbar = <PaneToolbar>
    <HStack flex="1" gap="2" minW="0">
      <Switch.Root size="sm" colorPalette="agentic" checked={logprobs} onCheckedChange={({ checked }) => void window.agentic.setLlmTrace({ logprobs: checked }).then((state) => setLogprobs(state.logprobs))}>
        <Switch.HiddenInput/><Switch.Control/><Switch.Label fontSize="xs" color="fg.muted">Probabilitat de cada token (més lent)</Switch.Label>
      </Switch.Root>
    </HStack>
    <Button size="xs" variant="ghost" onClick={() => void reload()}><RefreshCw size={14}/>Actualitza</Button>
    <Button size="xs" variant="ghost" onClick={() => void window.agentic.revealLlmCalls()}><FolderOpen size={14}/>Fitxer</Button>
    {confirmClear
      ? <Button size="xs" colorPalette="red" variant="subtle" onClick={() => { setConfirmClear(false); void window.agentic.clearLlmCalls().then(() => setCalls([])) }}><Trash size={14}/>Segur? Esborra el log</Button>
      : <Button size="xs" variant="ghost" onClick={() => { setConfirmClear(true); setTimeout(() => setConfirmClear(false), 4000) }}><Trash size={14}/>Esborra</Button>}
  </PaneToolbar>

  return <Pane label="Log del model" header={<PaneHeader icon={ScrollText} title="Log del model" subtitle="El que entra i surt del model a cada crida"/>} toolbar={toolbar}>
    <Box h="full" minH="0" {...scrollArea}><Stack gap="0">
      {error && <Text p="3" fontSize="sm" color="fg.error">{error}</Text>}
      {live && <Box px="3" py="2" borderBottomWidth="1px" borderColor="border">
        <HStack gap="2" mb="1.5"><Spinner size="xs" colorPalette="agentic"/><Badge size="xs" colorPalette={sourcePalette(live.source)}>{live.source}</Badge><Text fontSize="xs" color="fg.muted" truncate>{live.model} · generant…</Text></HStack>
        <Box {...mono}>{live.text || "…"}</Box>
      </Box>}
      {calls === null ? <HStack p="3" color="fg.muted"><Spinner size="sm"/><Text fontSize="sm">Llegint el log…</Text></HStack>
        : !calls.length && !live ? <Text p="3" fontSize="sm" color="fg.muted">Encara no hi ha cap crida. Mentre aquest panell és obert, cada missatge del xat (i cada avaluació que comencis) queda registrat aquí.</Text>
        : <Accordion.Root multiple collapsible size="sm" variant={PANE_ACCORDION} lazyMount>{calls.map((call) => <Accordion.Item key={call.id} value={call.id}>
          <Accordion.ItemTrigger>
            <HStack flex="1" gap="2" minW="0">
              <Text fontSize="xs" color="fg.muted" flex="none">{new Date(call.at).toLocaleTimeString("ca")}</Text>
              <Badge size="xs" colorPalette={sourcePalette(call.source)}>{call.source}</Badge>
              <Text fontSize="xs" truncate>{number(call.metrics.promptTokens)} → {number(call.metrics.generationTokens)} tokens · {number(call.metrics.seconds, " s")}{call.output.toolCalls.length ? ` · ${call.output.toolCalls.map((tool) => tool.name).join(", ")}` : ""}</Text>
              {(call.output.error || call.output.parseErrors.length > 0) && <Badge size="xs" colorPalette="red">error</Badge>}
            </HStack>
            <Accordion.ItemIndicator/>
          </Accordion.ItemTrigger>
          <Accordion.ItemContent><Accordion.ItemBody pt="0">
            <HStack justify="flex-end"><Button size="xs" variant="ghost" onClick={() => void navigator.clipboard.writeText(JSON.stringify(call, null, 2))}><Copy size={14}/>Copia com a JSON</Button></HStack>
            <CallDetail call={call}/>
          </Accordion.ItemBody></Accordion.ItemContent>
        </Accordion.Item>)}</Accordion.Root>}
    </Stack></Box>
  </Pane>
}
