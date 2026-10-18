### Sistema d'aprenentatge autònom, evolució del LLM i entrenament nocturn

Dissenya i implementa un sistema d'aprenentatge autònom que permeti a l'agent de programació millorar progressivament a partir dels projectes executats, els errors detectats, les solucions verificades i les proves superades.

#### 1. Model base i inferència local

- Utilitza com a model candidat principal Qwen3-Coder-Next, subjecte a una prova prèvia de compatibilitat, rendiment i memòria.
- Conserva els pesos originals com a versió immutable i recuperable.
- No utilitzis Ollama, llama.cpp ni un servidor d'inferència LLM separat.
- Integra la inferència dins de l'arquitectura de l'aplicació d'escriptori.
- Avalua Transformers.js amb ONNX Runtime per a la inferència JavaScript local.
- Si el model principal no és compatible amb aquest runtime, investiga una conversió ONNX vàlida o selecciona un model de programació alternatiu compatible. No simulis compatibilitat ni descarreguis formats incompatibles.
- Permet seleccionar models i quantitzacions segons la memòria i les capacitats del maquinari.
- Mantén els embeddings com un component independent del LLM generatiu.

#### 2. Aprenentatge durant el treball

L'agent ha de:

- Analitzar el codi i la documentació del projecte.
- Generar i modificar fitxers amb control de canvis.
- Executar proves automatitzades i inspeccionar l'aplicació al navegador.
- Registrar els errors, les causes identificades, les correccions aplicades i els resultats verificats.
- Crear exemples d'entrenament només a partir de dades seleccionades i amb procedència identificable.
- Actualitzar la memòria semàntica i l'índex d'embeddings sense modificar automàticament els pesos del model actiu.

#### 3. Mode d'aprenentatge en segon pla

Quan l'usuari finalitzi la sessió de treball, inicia un procés local d'aprenentatge subjecte a disponibilitat de recursos.

Tasques:

1. Revisar els resultats acumulats.
2. Eliminar duplicats, dades incorrectes i exemples de baixa qualitat.
3. Preparar un conjunt d'entrenament amb exemples verificats.
4. Separar les dades d'entrenament de les dades de validació i de les proves finals.
5. Actualitzar la memòria i els embeddings quan sigui necessari.
6. Executar fine-tuning o entrenament d'adaptadors només quan hi hagi prou dades i un mètode compatible amb el model.
7. Avaluar el candidat amb benchmarks i proves reals de programació.
8. Comparar els resultats amb els de la versió estable.
9. Publicar la nova versió només si supera els criteris de qualitat establerts.
10. Si no hi ha dades suficients, recursos disponibles o millores demostrables, no entrenar o no publicar cap versió nova.

L'entrenament s'ha d'executar mitjançant eines locals compatibles amb l'arquitectura del model. Aquest procés no ha de requerir un servidor LLM extern. No exigeixis que Transformers.js executi directament l'entrenament si no ho permet.

#### 4. Avaluació i control de versions

- Mantén una versió estable i una versió candidata separades.
- Utilitza un conjunt fix de tasques representatives de programació.
- Avalua compilació, proves unitàries, proves d'integració, regressions, qualitat dels canvis i capacitat de seguir instruccions.
- No utilitzis exclusivament un altre LLM com a jutge: prioritza els resultats executables i els criteris objectius.
- Registra mètriques, configuració, dades utilitzades, versió dels pesos i resultats de cada entrenament.
- Si el candidat empitjora, falla o no supera les proves, conserva la versió estable.
- Permet recuperar qualsevol versió anterior.
- No sobrescriguis mai els pesos originals.

#### 5. Aprenentatge entre models

Permet que un model professor generi propostes, exemples i explicacions per entrenar un model alumne, sempre que les dades passin filtres de qualitat.

El sistema ha de poder utilitzar diferents models locals en moments diferents, sense exigir que tots estiguin carregats simultàniament.

No assumeixis que les respostes d'un model són correctes. Verifica-les, combina-les amb exemples fiables i evita que el sistema s'entreni repetidament sobre errors propis.

#### 6. Recursos i autonomia

- Detecta l'activitat de l'usuari i prioritza el treball interactiu quan l'aplicació està en ús.
- Inicia les tasques intensives d'aprenentatge quan l'usuari les hagi acabat o quan autoritzi el mode en segon pla.
- Estableix límits configurables de RAM, CPU, GPU, espai en disc i durada.
- Pausa o interromp les tasques si els recursos són insuficients o l'usuari torna a treballar.
- Desa l'estat dels processos i reprèn les tasques interrompudes quan sigui segur.
- No bloquegis l'ordinador ni consumeixis tots els recursos disponibles.
- Mantén el sistema funcional encara que l'entrenament no es pugui executar.

#### 7. Privacitat i seguretat

- Executa el procés d'aprenentatge localment.
- No enviïs codi, credencials, secrets, dades personals o fitxers privats a serveis externs.
- Exclou els secrets dels registres i dels conjunts d'entrenament.
- Exigeix aprovació per als canvis que afectin dades sensibles o operacions destructives.
- Executa el codi generat en entorns controlats quan sigui possible.

#### 8. Criteri final d'acceptació

L'aplicació ha de poder programar projectes durant la sessió de treball, conservar experiències útils i, després de la sessió, preparar i entrenar candidats locals quan sigui viable. Les millores han de demostrar-se mitjançant avaluacions repetibles abans de substituir el model actiu.

La memòria persistent, els embeddings, les eines de l'agent, el fine-tuning i els pesos del model són components diferenciats. Implementa'ls amb interfícies modulars perquè es puguin substituir sense reconstruir tota l'aplicació.
