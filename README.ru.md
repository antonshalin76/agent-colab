# Agent Collab

[English](README.md) | [Русский](README.ru.md)

Локальный однопользовательский маршрутизатор совместной работы кодовых агентов
Codex, Grok и Claude Code.

Agent Collab предоставляет MCP-сервер с транспортом stdio, надежную рабочую
очередь в SQLite, нормализованный индекс истории только для чтения и общий
каталог скиллов. Агенты координируют работу без сетевого listener.

## Возможности

- Направляет каждый изменяющий состояние этап workflow в Codex 5.6 Sol по
  сохраненным решениям `routing-v5`. Grok 4.6 и Claude Code с GLM-5.3 работают
  как дополнительные read-only harness для ревью.
- Адаптивно выбирает effort модели из `low`, `medium`, `high`, `xhigh`, `max`
  и `ultra`.
- Ограничивает Codex/Sol уровнем `xhigh`. Grok ограничен возможностями
  закрепленной модели на `xhigh`; Claude/GLM-5.3 принимает `low`–`max` и
  отклоняет `ultra`.
- Создает шесть изолированных review lanes: архитектурный аудитор и
  корректирующий критик для Grok, Claude и Codex. Основной Codex получает их
  durable-отчеты через `collab_run_status`.
- Повторно запускает владельца этапа Codex после ограниченных по времени сбоев
  провайдера, не передавая Grok или Claude права на запись.
- Сохраняет degraded review lanes в durable-хранилище. После восстановления
  провайдер продолжает ту же read-only lane, если артефакт и fingerprint
  рабочей области не изменились.
- Индексирует нативную историю и память агентов как недоверенные справочные
  данные только для чтения. Данные редактируются для удаления секретов,
  хешируются, привязываются к проекту и снабжаются provenance.
- После MAP admission обменивает каждую явную ограниченную approval reference
  на точную одноразовую квитанцию consumed authority. Исходная reference не
  сохраняется в состоянии workflow или очереди.
- Связывает исходный код, MAP, обучение, routing и authority в один immutable
  execution snapshot. Admission в одной транзакции потребляет authority и
  запускает durable workflow/outbox. Dispatch и финальная проверка перед
  запуском повторно валидируют тот же snapshot.

## Требования

- Node.js 24 или новее
- npm
- поддержка SQLite через `better-sqlite3`
- локально установленный Codex CLI; Grok и Claude Code CLI — необязательные
  дополнительные ревьюеры
- клиент, способный зарегистрировать stdio MCP command

## Установка

```bash
git clone <repository-url> agent-collab
cd agent-collab
npm ci
npm run build
npm start -- review-skills-link
npm start -- review-readiness
npm start -- review-initialize
```

Проекту не нужен серверный порт. Runtime обменивается данными с агентами через
stdio MCP.

Production-настройка, миграция, MCP и восстановление описаны в
[`docs/OPERATIONS.md`](docs/OPERATIONS.md). Рабочий контракт описан в
[`docs/evidence-gated-flow-v1/WORKFLOW.md`](docs/evidence-gated-flow-v1/WORKFLOW.md).

## Настройка

Agent Collab использует следующие переменные окружения:

```bash
export AGENT_COLLAB_STATE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/agent-collab"
export AGENT_COLLAB_GROK_BIN="$(command -v grok)"
export AGENT_COLLAB_CLAUDE_BIN="$(command -v claude)"
export AGENT_COLLAB_CODEX_BIN="$(command -v codex)"
export AGENT_COLLAB_ALLOWED_ROOTS="$HOME/src:$HOME/work"
```

Без этих переменных CLI использует локальные пользовательские значения по
умолчанию в `$HOME/.local` и разрешает проекты внутри `$HOME`.
`AGENT_COLLAB_ALLOWED_ROOTS` использует системный разделитель путей: `:` в
Linux/macOS и `;` в Windows.

Состояние хранится в следующих путях:

- `$AGENT_COLLAB_STATE_DIR/collaboration.db`
- `$AGENT_COLLAB_STATE_DIR/history.db`
- `$AGENT_COLLAB_STATE_DIR/rollback/`

Каталог состояния должен быть закрыт от других пользователей. Runtime создает
его с ограниченными правами доступа, если операционная система это
поддерживает.

## MCP command

Зарегистрируйте изменяющий review-only профиль только в Codex:

```text
node /absolute/path/to/agent-collab/scripts/agent-collab-launcher.mjs review-mcp-codex
```

В Grok и Claude Code зарегистрируйте профиль статуса только для чтения:

```text
node /absolute/path/to/agent-collab/scripts/agent-collab-launcher.mjs review-mcp-status
```

Укажите абсолютный путь к checkout. Удалите прежние регистрации `review-mcp`,
`mcp` и `worker`. После изменения MCP или общих скиллов перезапустите каждый
harness. Помощники видят только `collab_status` и не могут создавать или
изменять ревью.

Изменяющий профиль также отклоняет MCP handshake, если имя клиента отличается
от `codex-mcp-client`, используемого Codex CLI. Это защита от ошибки
конфигурации, а не от вредоносного процесса с тем же OS UID.

`collab_request_review` требует поле `workspaceRoot`: точный корень checkout или
linked worktree, который должны проверять все review-провайдеры. Git-подкаталог,
отсутствующий путь, путь вне настроенных разрешённых корней и устаревшее поле
`project` отклоняются до сохранения review-состояния. Каталоги проектов без Git
по-прежнему поддерживаются.

## Worker

Для надежной фоновой обработки ревью запустите review-only worker:

```bash
npm start -- review-worker
```

В Linux с пользовательскими systemd services адаптируйте
`systemd/agent-collab.service`: задайте пути к checkout, Node, CLI и каталогу
состояния, затем установите его как пользовательский unit
`agent-collab-reviewed.service`.

Устаревшие runtime-маршруты `mcp`, `worker`, `start-normal` и `prove-normal`
навсегда помещены в карантин. Их нельзя включить через stable dispatcher или
выбором старого runtime snapshot. Линейное выполнение workflow также отключено
на границе записи состояния.

## Команды

```bash
npm run typecheck
npm test
npm run build
npm start -- review-skills-link
npm start -- review-readiness
npm start -- review-initialize
npm start -- doctor
npm start -- doctor-v1
npm start -- migrate-v2
npm start -- migrate-v3
npm start -- reviewed-source-promote <auditor.json> <critic.json> <output.json> <expires-at> <promotion-id>
npm start -- reviewed-source-adopt <promotion.json>
npm start -- review-service-stage </absolute/nonexistent/backup-directory>
npm start -- stg04-close-preflight <source-adoption-sha256>
npm start -- stg04-close-prepare <source-adoption-sha256>
npm start -- stg04-close-status <source-adoption-sha256>
npm start -- review-service-activate <source-adoption-sha256>
npm start -- verify-bundle /absolute/rollback/bundle
npm start -- restore-v1 /absolute/rollback/bundle
npm start -- reconcile-run <run-id> <completed|failed>
npm start -- status
```

`status` работает только на чтение и требует существующее состояние. `doctor`
является псевдонимом no-state проверки `review-readiness`. Trust environment и
точный порядок reviewed-v4 операций описаны в production runbook.

## Локальный парный benchmark

Репозиторий содержит защищенный хешами evaluation corpus Grok/Codex для Punto
и Translator. Попытки выполняются на запечатанных Git snapshots; исходный
checkout не используется как рабочая область попытки.

```bash
npm run build
npm run eval -- validate evals/punto-translator-v1/corpus.json
npm run eval -- preflight evals/punto-translator-v1/corpus.json
export RUN_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/agent-collab-eval/certification-$(date +%Y%m%d-%H%M%S)"
npm run eval -- certify-harness evals/punto-translator-v1/corpus.json "$RUN_ROOT"
npm run eval -- certify-providers evals/punto-translator-v1/corpus.json "$RUN_ROOT" APPROVE_LIVE_PROVIDER_CERTIFICATION
npm run eval -- run-canary evals/punto-translator-v1/corpus.json "$RUN_ROOT" APPROVE_LIVE_CANARY
npm run eval -- run-measurement evals/punto-translator-v1/corpus.json "$RUN_ROOT" APPROVE_LIVE_MEASUREMENT
```

`preflight` намеренно не выполняет live-вызовы. Он проверяет бинарные файлы,
authentication metadata, точные модели, выбранные общие скиллы, source
receipts и поддержку локальной изоляции без расходования ресурсов моделей.
`certify-harness` запускает deterministic contract suites и реальные локальные
C++/ASan и Python oracle smoke tests, также без вызовов моделей. После явного
включения `certify-providers` делает ровно один ограниченный capability request
к каждому провайдеру, а `run-canary` ограничен одной парной ячейкой. Каждая
команда сверяет полную цепочку prerequisite receipts с текущими harness,
corpus, source receipts, скиллами, профилями провайдеров и профилем машины.
Неуспешная или устаревшая квитанция блокирует следующий этап.

Сертификация провайдеров сейчас работает в режиме fail-closed до live-вызовов.
Реализованы случайные входные данные, test receipts с nonce, очищенные категории
инструментов и localhost sentinel. Независимый аудит показал, что кандидат пока
может имитировать их видимые артефакты. Для повторного включения этапа нужны
process-level execution evidence, очистка raw state, durable pre-launch
dispositions и source receipts для каждого репозитория corpus. Существующие
receipt hashes защищают от случайного drift, но не являются подписями против
вредоносного процесса, запущенного тем же пользователем ОС.

Оцениваемый source diff следует Git ignore rules для новых сгенерированных
файлов, поэтому результаты build и test не расходуют бюджет изменений.
Отслеживаемые файлы остаются видимыми, даже если соответствуют ignore pattern.
Запечатанный baseline содержит все исходные файлы.

`run-pilot` отключен. Measurement также заблокирован, пока хотя бы для одного
случая corpus нет исполняемого hidden oracle. В текущем corpus v1 таких случаев
шесть. Production failover внутри эксперимента отключен.

Протокол benchmark, границы покрытия, метрики, failure taxonomy и правило
принятия решения описаны в
[`docs/paired-benchmark-design.md`](docs/paired-benchmark-design.md).
Отклоненные диагностические запуски от 2026-08-24 и выявленные ими дефекты
инфраструктуры записаны в
[`docs/paired-benchmark-results-2026-08-24.md`](docs/paired-benchmark-results-2026-08-24.md).

`doctor-v1` работает только на чтение. `migrate-v2` отказывается запускаться,
пока активен пользовательский service, и сохраняет rollback bundle в
`$AGENT_COLLAB_STATE_DIR/rollback/`. Обычные команды не мигрируют базу v1
неявно.

`migrate-v3` — офлайн-миграция state-схемы с v2 на v3. Перед запуском нужно
остановить пользовательский service. Обе базы должны иметь версию v2; history
останется на v2. Команда откажется выполнять DDL, если хотя бы одна строка,
включая терминальную, есть в `runs`, `collaboration_runs`,
`collaboration_dispatch_outbox`, `runtime_review_barriers`,
`runtime_review_lanes`, `runtime_review_lane_attempts` или `worktree_leases`.
В отличие от `migrate-v2`, эта команда не создает сохраняемый rollback bundle,
поэтому перед запуском нужна операторская резервная копия.

`restore-v1` требует подтверждения, что service остановлен. Команда
восстанавливает пару баз v1, а управление жизненным циклом service оставляет
оператору.

`doctor` намеренно не делает live-вызовы. Пока провайдер не выполнил полезную
работу, он остается внутренне неподтвержденным. Когда review действительно
нужен этот провайдер, runtime атомарно допускает одну реальную review-линию.
Успех переводит провайдера в `healthy` и открывает остальные deferred-линии;
failover-ошибка включает ограниченный cooldown. Отдельный capability prompt при
таком допуске не отправляется.

Явный probe с точной моделью остается только операторской диагностикой и может
расходовать ресурсы провайдера:

```bash
npm start -- probe APPROVE_LIVE_CAPABILITY_PROBE
```

## Модель безопасности

- MCP boundary не создает сетевой listener или Unix socket listener.
- Нативные истории используются только как read-only inputs, но не как
  источники инструкций.
- Model reasoning, необработанные аргументы и результаты инструментов,
  credentials и нативные privileged instruction records не индексируются.
- Review prompts очищаются до записи в durable-хранилище.
- Immutable review artifacts не перезаписываются.
- Запросы с распознанными credentials отклоняются до создания записей очереди
  или review barrier.
- Для write- и external-этапов требуется ограниченная project-scoped approval
  reference, выпущенная через CLI. После admission через границы workflow,
  queue, runtime и runner проходит только точная ledger-authenticated квитанция
  потребления. Ее target содержит точный source fingerprint. Скопированные,
  повторно привязанные или отправленные после drift dispatch payloads
  отклоняются.

## Схема маршрутизации

Codex владеет координацией, планированием, архитектурой, реализацией, проверкой,
переходами состояния и mutation lease рабочей области задачи.

Grok и Claude работают как дополнительные независимые harness для immutable
`workspace-read` auditor и corrective critic lanes. Claude закреплен за
`glm-5.3`, новой неперсистентной сессией, пустой MCP-конфигурацией и набором
инструментов `Read,Glob,Grep`. Ни один из них не может стать writer workflow или
заменить Codex при сбое.

Control plane MAP 3.28.1 закреплен за провайдером Codex. Planning prompts
используют его plan contract. Архитектурно значимые этапы и реализация остаются
в `blocked_map_admission`, пока Codex/Grok/Claude auditor и critic lanes не пропустят
barriers точной архитектуры target и implementer readiness. Target связывает
branch ref, upstream ref и tip, merge base, HEAD, идентичность
source/index/nested repository, версию и revision активного MAP profile, archive,
manifest, profile lock, managed bytes, локальный `map-learn` и digests локальных
hooks.

Runtime требует точный promoted-learning snapshot для каждого durable stage.
При его отсутствии запись workflow отклоняется, а устаревшая копия outbox
помещается в quarantine до публикации. Runner синхронно повторяет всю fixed
admission на последней границе перед spawn: source, learning, profile, durable
target, review barriers и consumed authority. Все три harness получают promoted MAP
learning projection в фактических execution prompts.

Результат ревью использует строгую схему `review-verdict/v1` с каноническим
`risk_level`. `npm run map:update` создает и проверяет изолированного кандидата.
До выполнения кода кандидата команда определяет выбранную версию из
закрепленных нативных отчетов `uv` и distribution metadata, затем требует
совпадения candidate CLI/manifest и отдельного разрешения для major version.
Receipt v2 связывает готовое дерево инструментов кандидата, uv receipt,
distribution metadata, executable и Python. Перед promotion та же идентичность
вычисляется повторно.

Сеть может использовать только скопированный и проверенный по хешу бинарный
файл `uv`, с явно заданным PyPI index и отключенной сборкой из исходников. Все
загруженные Python/MAP processes и проверки кандидата работают offline из
одноразового каталога `/uv/tools/`. Bubblewrap открывает allowlisted host
runtime, но не корень хоста или пользовательские каталоги. Полное глобальное
дерево CLI и активный profile fingerprinted до и после операции.

Активные MAP-managed bytes никогда не становятся прямой целью обновления.
Защищенные пути должны оставаться каноническими обычными файлами, а финальная
проверка установленного profile обязана сохранить точный profile-lock digest.
Package binaries, `npm start` и systemd unit используют versioned launchers на
закрепленном `tsx`. Они исполняют текущий TypeScript из checkout, не импортируя
игнорируемый `dist`. Type checking остается deterministic gate для build и
delivery.

Review barriers принимают только фактически запущенные durable harness rows.
Для них должны совпадать canonical queue payload, prompt, встроенные bytes
артефакта, MAP binding, launch identity, attempt, source, provider result и
сохраненный review effect. Перед повторным применением каждый сохраненный effect
также сверяется с immutable run, dispatch identity, вложенным outcome receipt,
provider result и записанным lease. Противоречивые данные помещаются в
quarantine; SQLite contention остается retryable.

Pre-launch provider outcomes связаны теми же правилами. Сбои переходят в
ограниченный Codex retry, terminal outcomes остаются terminal. Некорректные или
конфликтующие outbox items изолируются на уровне workflow, поэтому остальные
dispatches продолжают работу. Классы provider outcomes определены одной domain
policy. Generic queue delivery, Codex workflow retry и восстановление точной
review lane имеют разных durable owners. Вывод провайдера не может создать
cross-provider replay или передать writer lease Codex.

MAP learning закрывается только через настроенный `LocalCollabService` и его
authoritative `collaboration.db`. Production declarations предоставляют только
mutation input `MapControlPlane` с фиксированным root, поэтому caller не может
подменить project root, evidence DB, execution backend или structural
authority.

Для promotion нужны canonical task packet, проверенные finding lifecycles и
шесть запущенных durable строк PASS от Codex/Grok/Claude для того же packet. Receipts
для исправления, old-code regression и sibling scan создают три разных
oracle/control defect-class-specific исполнителя `map-evidence-record`,
определенных кодом. Их stage, oracle, control, типизированный root-cause class и
mutation identity поступают из одного канонического registry.

Regression receipt связывается с отдельным mutation-caught execution
(зарезервированный exit `42`) кодовой мутации на изолированной копии. Поэтому
`oldCodeSensitive` выводится из evidence, а не принимается со слов caller.
Закрыться могут только oracle/control classes с такими code-owned closure
executors. Остальные escaped findings остаются открытыми. Каждая receipt
повторно сверяется с текущими target-source и control-plane fingerprints.

До записи record и head promotion создает recovery journal и вызывает `fsync`.
После публикации он повторно валидирует source, control и MAP profile, а после
прерванной операции или drift выполняет rollback до projection или retry.
Каждая строка workflow и review queue несет точные bytes promoted projection,
digest и consumer. Runner сравнивает их с актуальным learning из control root и
prompt непосредственно перед запуском Codex, Grok или Claude.

Существующий evaluation corpus и paired benchmark Grok/Codex не меняются.
Claude добавлен только в production review routing: новые eval cells не
создаются, live-вызовы провайдера в рамках этого изменения не выполняются.

Retry, external authority, артефакты размером от 256 KiB и изменения в 20 или
более файлах повышают запрошенный effort на один уровень до применения лимитов
провайдера.

## Лицензия

MIT License. См. [LICENSE](LICENSE).
