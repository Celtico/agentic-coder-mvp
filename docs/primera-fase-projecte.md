# PROJECTE: Agentic Desktop IDE — programació autònoma amb LLM local integrat

## 1. Objectiu del projecte

Desenvolupa una aplicació d'escriptori per a macOS amb Apple Silicon que permeti programar projectes existents mitjançant instruccions en llenguatge natural.

L'experiència d'usuari ha de permetre:

1. Seleccionar un projecte local.
2. Explicar què vull modificar o construir.
3. Deixar que l'agent inspeccioni el projecte i planifiqui la feina.
4. Permetre que l'agent llegeixi, creï i modifiqui fitxers.
5. Executar ordres i iniciar l'aplicació.
6. Inspeccionar el resultat real al navegador.
7. Detectar errors, corregir-los i tornar a provar.
8. Mostrar els canvis, les proves i els resultats finals.

L'objectiu és reproduir el flux de treball d'un agent avançat de programació, no simplement construir un xat amb un model local.

## 2. Restricció fonamental: inferència local integrada

L'aplicació no ha de dependre de:

- Claude ni d'altres serveis remots d'IA.
- Ollama.
- llama.cpp com a executable o servei separat.
- LM Studio.
- Jan.
- Un servidor HTTP extern per executar el model.
- Una API de pagament per generar respostes.

La inferència ha de funcionar localment al Mac.

Selecciona una biblioteca o runtime d'inferència que es pugui integrar o distribuir dins de l'aplicació, amb suport adequat per a Apple Silicon i acceleració Metal quan sigui possible.

No assumeixis que un model és executable directament sense un motor d'inferència.

Avalua les opcions segons:

- Compatibilitat amb macOS i Apple Silicon.
- Acceleració GPU mitjançant Metal.
- Formats de models i quantització admesos.
- Rendiment i consum de memòria.
- Capacitat de generar codi.
- Capacitat d'utilitzar eines de manera estructurada.
- Llicència de la biblioteca i del model.
- Possibilitat de distribuir els components amb l'aplicació.

Investiga primer les alternatives i documenta la decisió. No implementis un runtime propi des de zero si existeix una biblioteca adequada.

Mantén una interfície `InferenceEngine` perquè el motor es pugui substituir sense reescriure l'orquestrador.

La distribució inicial pot requerir descarregar el model una vegada. Després, la inferència ha de funcionar sense Internet. No enviïs prompts, codi, fitxers ni telemetria a serveis externs.

## 3. Arquitectura de programari

Utilitza TypeScript com a llenguatge principal.

### Aplicació d'escriptori

- Electron.
- React.
- TypeScript.
- Vite.
- Una interfície moderna i professional, optimitzada per a macOS.

Separa estrictament el procés principal d'Electron, el procés de renderització i els components que executen codi.

Activa `contextIsolation`, desactiva `nodeIntegration` al renderer i exposa només les funcions necessàries mitjançant una API IPC restringida.

### Motor d'inferència

Defineix una interfície comuna, per exemple:

- `loadModel()`
- `unloadModel()`
- `generateResponse()`
- `streamResponse()`
- `cancelGeneration()`
- `getModelStatus()`
- `getMemoryUsage()`

Implementa-la amb un motor embegut real, no amb una simulació.

La descàrrega de models ha de ser explícita, amb verificació d'integritat, llicències, gestió de versions i espai de disc.

### Orquestrador

Implementa un agent propi en TypeScript responsable de:

- Interpretar la petició de l'usuari.
- Inspeccionar el projecte.
- Crear un pla de treball.
- Seleccionar eines.
- Validar els arguments de cada eina.
- Executar les accions autoritzades.
- Retornar els resultats al model.
- Gestionar errors, intents i cancel·lacions.
- Verificar els criteris d'acceptació.
- Resumir els canvis realitzats.

L'orquestrador no ha de confiar que el model executi correctament les seves instruccions. Cada acció ha de passar per un executor controlat.

## 4. Bucle tool use loop

Implementa un cicle agentic real:

1. Enviar al model la petició, el context i les eines disponibles.
2. Rebre una resposta o una sol·licitud estructurada d'eina.
3. Validar la sol·licitud.
4. Executar l'eina si està autoritzada.
5. Recollir el resultat real.
6. Afegir el resultat al context de la conversa.
7. Tornar a consultar el model.
8. Repetir fins que la tasca estigui completada, cancel·lada o bloquejada.

Defineix límits configurables per a iteracions, temps, tokens, consum de memòria i execució de processos.

Si el model no suporta crides natives a eines, implementa un adaptador que validi sortides estructurades i rebutgi les que no compleixin l'esquema.

No permetis que una resposta textual del model es confongui amb una acció executada realment.

## 5. Sistema d'eines

Implementa eines modulars i tipades.

### Sistema de fitxers

- Llistar directoris.
- Llegir fitxers.
- Cercar símbols i contingut.
- Crear fitxers.
- Modificar fitxers.
- Eliminar fitxers amb autorització.
- Mostrar diferències abans i després dels canvis.

L'accés ha d'estar limitat al projecte autoritzat i als directoris explícitament aprovats.

### Terminal

- Executar ordres de desenvolupament.
- Instal·lar dependències quan s'autoritzi.
- Executar scripts i proves.
- Iniciar i aturar servidors de desenvolupament.
- Capturar stdout, stderr i codis de sortida.
- Gestionar processos i temps d'espera.

No permetis execució il·limitada de shell. Aplica límits, permisos i confirmació per a accions destructives, privilegis elevats o operacions que afectin dades fora del projecte.

### Git

- Detectar l'estat del repositori.
- Mostrar canvis.
- Consultar diffs.
- Crear branques de treball.
- Preparar commits, sense publicar-los automàticament.
- Permetre revertir canvis.

No executis push, esborrats de branques ni operacions destructives sense confirmació explícita.

### Navegador

Integra Playwright per permetre:

- Obrir l'aplicació local.
- Navegar per les pàgines.
- Inspeccionar el DOM.
- Cercar elements.
- Fer clic i omplir formularis.
- Capturar pantalles.
- Consultar errors de consola.
- Detectar fallades de càrrega i peticions.
- Executar proves d'interfície.

El navegador ha de retornar observacions reals a l'orquestrador.

No consideris que una pàgina funciona només perquè s'ha carregat. Verifica els elements i comportaments exigits per la tasca.

Prioritza un navegador local empaquetat o una instal·lació gestionada per l'aplicació. Documenta les dependències necessàries.

## 6. Context i memòria de projecte

Implementa:

- Historial de converses.
- Sessions per projecte.
- Instruccions permanents del projecte.
- Resums de tasques llargues.
- Llista de fitxers rellevants.
- Registre d'accions i resultats.
- Recuperació després d'interrupcions.
- Persistència local mitjançant SQLite.

No carreguis tot el repositori al context del model.

Inspecciona l'estructura, ignora directoris generats, cerca els fitxers rellevants i incorpora només el context necessari.

Respecta `.gitignore` i permet configurar exclusió de secrets, credencials, fitxers binaris i altres dades sensibles.

No utilitzis automàticament dades excloses per a indexació ni per a diagnòstics.

## 7. Flux de treball complet

Quan l'usuari demani una tasca, l'agent ha de:

1. Comprendre l'objectiu.
2. Inspeccionar el projecte.
3. Identificar la tecnologia i les instruccions existents.
4. Formular un pla breu.
5. Identificar els fitxers que cal modificar.
6. Implementar els canvis.
7. Executar les proves adequades.
8. Iniciar l'aplicació quan sigui necessari.
9. Inspeccionar-la amb Playwright.
10. Detectar errors reals.
11. Corregir-los i tornar a executar les comprovacions.
12. Comparar el resultat amb els criteris d'acceptació.
13. Presentar un resum amb els fitxers modificats, les proves executades, els resultats i les limitacions pendents.

Si una prova falla, no declaris la tasca acabada.

Si el model no pot resoldre un error després dels intents configurats, mostra el diagnòstic i demana ajuda.

## 8. Interfície d'usuari

Crea una interfície d'escriptori amb:

- Selector i historial de projectes.
- Xat principal.
- Visualització del pla de treball.
- Indicador de l'acció actual.
- Llista d'eines executades.
- Sortida de terminal.
- Visor de diff.
- Estat de les proves.
- Vista del navegador.
- Historial d'activitat.
- Controls per pausar, continuar i cancel·lar.
- Configuració del model i del consum de recursos.

L'usuari ha de poder veure què està fent l'agent i aprovar les operacions sensibles.

No presentis resultats inventats ni indicadors d'èxit sense proves reals.

## 9. Rendiment i gestió de recursos

Optimitza l'aplicació per a Apple Silicon.

- Utilitza streaming quan el motor ho permeti.
- Evita bloquejar la interfície durant la inferència.
- Gestiona correctament cancel·lacions.
- Controla la memòria i les càrregues simultànies.
- Permet descarregar el model de memòria.
- Informa de les limitacions del model i de la memòria disponible.
- Gestiona contextos massa llargs mitjançant resum i recuperació selectiva.

Selecciona un model adequat a la memòria del dispositiu. No pressuposis que el model més gran és necessàriament el millor.

## 10. Seguretat i privacitat

L'aplicació ha de funcionar localment per defecte.

- Sense telemetria per defecte.
- Sense enviament de codi a serveis externs.
- Protecció de credencials i variables d'entorn.
- Restricció de directoris.
- Validació de les crides a eines.
- Registre d'accions sense secrets.
- Confirmació d'accions destructives.
- Aïllament dels processos quan sigui possible.
- Protecció contra instruccions malicioses contingudes en fitxers del projecte.
- Límits de xarxa i de processos.
- Opció d'executar proves dins d'un entorn aïllat.

L'agent no ha de poder llegir arbitràriament el disc, executar ordres privilegiades o enviar dades a Internet sense autorització.

## 11. Estratègia de desenvolupament

Construeix el projecte en fases.

### Fase 1: viabilitat del motor

Abans de construir la interfície completa, demostra que el motor seleccionat pot carregar un model real i generar respostes localment al Mac objectiu.

### Fase 2: orquestrador mínim

Implementa el bucle d'eines amb lectura i escriptura de fitxers, terminal, validació d'arguments i cancel·lació.

### Fase 3: integració del navegador

Afegeix Playwright i demostra el cicle de modificació, execució, inspecció i correcció.

### Fase 4: interfície d'escriptori

Integra el xat, les eines, el navegador, el diff i les proves.

### Fase 5: memòria i robustesa

Afegeix persistència, resum del context, recuperació d'errors i gestió de recursos.

### Fase 6: distribució

Prepara una aplicació instal·lable per a macOS, amb dependències, permisos, documentació i gestió del model.

## 12. Criteris d'acceptació finals

La versió funcional s'ha de demostrar amb un projecte real de prova.

L'usuari ha de poder demanar una modificació, i l'agent ha de:

- Inspeccionar els fitxers reals.
- Proposar un pla.
- Modificar el codi.
- Mostrar el diff.
- Executar una prova.
- Iniciar l'aplicació.
- Inspeccionar el resultat al navegador.
- Detectar almenys un error reproduïble en una prova preparada.
- Corregir-lo i repetir la prova.
- Informar del resultat final amb evidències.

Demostra també que el model funciona sense connexió a Internet després de la instal·lació i descàrrega inicial dels recursos necessaris.

Si una funcionalitat no funciona, declara-la pendent en lloc de simular-ne l'èxit.

## 13. Forma de treball

Treballa directament sobre el repositori del projecte seleccionat.

Abans de començar, inspecciona l'entorn, comprova les dependències disponibles i proposa l'arquitectura concreta del motor d'inferència.

Implementa verticalment les funcionalitats, amb proves reals a cada fase.

No reescriguis innecessàriament el projecte existent. Mantén els canvis petits, revisables i documentats.

Prioritza una primera versió funcional i verificable abans d'afegir característiques secundàries.

Al final, proporciona instruccions reproduïbles per instal·lar, executar, provar, empaquetar i depurar l'aplicació.

L'objectiu final és disposar d'un agent de programació autònom, local, extensible i verificable, amb un motor d'inferència integrat i sense dependència obligatòria de serveis externs d'IA.
