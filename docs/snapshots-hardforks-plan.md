# Снапшоты и переходы между хардфорками: план реализации

Редакция 4, одобрена по результатам ревью. Основание: `main` на коммите `0acee41`, 2026-10-02.

Статус: подготовительные P0–P1 выполнены. Проверки на реальных клиентах воспроизвели потерю PTC;
входы, state inventory, команды и результаты находятся в [отчёте P0–P1](snapshots-p0-p1.md).
Snapshot API и переходы ещё не реализованы.

Текущий рабочий профиль — только Gloas. Pectra временно исключена из CI, новых релизов и матрицы
проверок по умолчанию через `src/active_profiles.ts`. Дальнейшие P2–P10 выполняются на Gloas;
повторные сборки и проверки отдельного Pectra-профиля отложены. Исторические результаты P0–P1
сохранены. Ранние эпохи Electra/Fulu в расписании Gloas-клиента остаются частью проверки переходов.

Все подготовительные работы ниже входят в реализацию. Выяснение версий, исправление клиентов и
создание проверок — работа исполнителя, а не задача пользователя.

## 1. Результат для пользователя

Снапшот: подготовить сеть и протокол один раз, сохранить, выполнить сценарий, восстановить ту же
точку и выполнить другой сценарий. Возвращаются данные EL/CL/VC и протокольное время. Снимок
многоразовый и переживает процесс при постоянном хранилище.

Переход: задать расписание до запуска, начать с Pectra, пройти Fusaka, затем Gloas в той же цепочке.
Клиенты знают все эти правила заранее. В момент активации образ не собирается и контейнеры не
заменяются.

Комбинация: подготовить состояние перед обновлением, сохранить его, пройти обновление, проверить
один сценарий, восстановиться и проверить другой. Расписание при restore не меняется.

Первая версия: controlled-сеть Panda, mainnet timing, принадлежащие ей тестовые валидаторы,
сохранение на завершённом хвосте слота, те же совместимые образы/платформа. Не включает hot/VM
snapshots, baseline mode, внешний signer, перенос снимков между хостами, произвольные миграции
клиентских БД или смену версии бинарника непосредственно на границе форка.

## 2. Проблема сохранения PTC

PTC — Payload Timeliness Committee. Валидаторы Gloas посылают подписанные сообщения о наличии
execution payload и доступности blob-данных. Из этих сообщений формируются подтверждения для
следующего блока.

В точном Lighthouse pin 2d281dfa1b407f7c81cd123954a9fd18ee8f02d2 пул payload_attestation_messages не
входит в PersistedOperationPool и создаётся пустым после чтения БД. При этом
get_payload_attestations для нового блока читает сообщения предыдущего слота.

В P1 подтверждено исполненными native и real-client regressions: после штатного BN/VC или полного
EL/BN/VC restart на хвосте слота 3 блок 4 теряет все 512 PTC-позиций и получает другой state root.
Сам блок строится, EL/CL остаются согласованы. Это потеря точного продолжения, а не доказательство
остановки цепочки при любом restart. См. [границы и результаты проверки](snapshots-p0-p1.md).

Решение включено в P1 и P3: сначала воспроизвести native regression с настоящими подписями, затем
сохранить и восстановить недостающие данные, затем проверить реальный stop/resume и следующий блок.

## 3. Выявленные препятствия и назначенные работы

- R1. PTC теряется в сериализации op_pool — подтверждено источником. Действия P1/P3.
- R2. При старте BN naive attestation/sync aggregation pools пустые. Часть аттестаций переносится в
  постоянный op_pool только при создании следующего блока. Необходимость каждого буфера именно на
  выбранном хвосте слота выясняется P0/P1; P3 сохраняет требуемые данные или переносит их обычным
  проверенным путём без нового блока.
- R2a. Pending payload envelopes, DA checker и pending payload caches сбрасываются при старте. P0
  классифицирует их: кеш восстановить, незавершённую доставку завершить либо отказать; нельзя
  потерять непроверенный payload/DA и назвать cut согласованным. Отсутствующий persisted op_pool при
  restore не должен молча заменяться пустым.
- R3. Очередь forkchoice attestations не записывается в persisted forkchoice. На нормальном хвосте
  она может уже быть обработана, но это нужно проверить. Фактический forkchoice slot может опережать
  protocol slot. P3 проверяет/сохраняет очередь и записывает реальный FC slot; не угадывает его из
  времени.
- R4. Network.start всегда создаёт genesis, stop удаляет volumes; время, completion marks и Engine
  payload readiness находятся в памяти. Действия P2/P3: отдельный запуск существующих данных,
  недеструктивная остановка, parked startup и новая сессия контроллера.
- R5. Timeline lock не перекрывает EL/CL/VC RPC. Есть гонки automine/advance/import, прямые relays и
  долгие SSE. Пустой EL txpool сам по себе может быть недостаточен: исследовательский Geth имеет
  deferred local tracking, но его соответствие опубликованному образу не доказано. P2 ставит
  управляемый вход и журнал незавершённых EL submissions, сохраняя обычную семантику Geth.
- R6. Fresh VC разрешает создать новую slashing DB; это недопустимо при restore. Возврат старой сети
  вместе с БД подписей создаёт альтернативную тестовую ветку, а не глобальную защиту от
  противоречащих подписей. Действия P0/P3/P5.
- R7. Ошибка persistence Lighthouse при shutdown может только попасть в лог. Успешное завершение
  процесса не доказывает сохранность. P3 вводит явный checkpoint ACK, проверку записи и фактическое
  восстановление.
- R8. Копирование/restore могут оборваться на диске, в процессе запуска или после commit. P4/P5
  вводят сохранение во временное место, контроль целостности, отдельную generation, журнал стадий и
  однозначное recovery.
- R9. Текущие fork phases, payload/finality decoding и часть параметров привязаны к profile
  навсегда. Clock mark ABI отличается между сборками. P6/P7 разделяют семейство образов, active fork
  и native ABI.
- R10. Исследованный ранее Geth checkout не равен реальному образу. В реальном бинарнике revision
  5d8fd6b6082f9aa330dbaf5df52dfcfdb445f186 и vcs.modified=true. P0 получает полный build diff либо
  собирает новый Geth из известных входов.
- R11. Внешний provider/оракул/индексатор помнит отменённые события и кеши. P9 поставляет
  проверенный порядок сброса и пример fixture.
- R12. Fast crossing может пропустить обязательную обработку границы или превысить requested
  timestamp. P8 проверяет весь диапазон заранее и сохраняет точную цель времени.
- R13. В P1 генератор с будущим Fulu и дефолтными BPO epochs создал порядок форков, отвергнутый
  Geth. Явное согласование BPO epochs прошло. P6 компилирует и валидирует CL blob schedule, BPO и
  соответствующие EL timestamps вместе с основными hardfork epochs.

Это перечень найденных фактов и проверяемых рисков. Проверки неизвестного поведения также назначены
этапам; ни один риск не считается исправленным по одному чтению кода.

## 4. Принятые решения

### 4.1 Сохранение и восстановление

- Create разрешён только в healthy controlled сети на завершённом хвосте слота. Время ради save не
  продвигается.
- Нет pending/queued EL tx и принятых, но не разрешённых EL submissions. Неоднозначный результат RPC
  блокирует create с конкретной причиной.
- Поддерживаемые native CL операции (voluntary exits, BLS changes, slashings) сохраняются с
  pool/state status и проходят round-trip/continuation проверки. Неизвестный тип либо недоказанная
  persistence вызывают явный отказ. GET pool может содержать уже включённые операции до
  pruning/finality; это не основание считать их неподтверждёнными. Решение основано на native
  inventory и текущем state, а не просто на непустом HTTP-списке.
- Очереди уже внутри consensus state (депозиты, консолидации, exits, withdrawals) сохраняются, их не
  требуется опустошать.
- Обычные protocol pools (attestation/sync/PTC) входят в продолжение; требование «все CL pools
  пустые» запрещено.
- Restore разрешён также после faulted advance и падения клиента. Он не проходит через
  Timeline.assertHealthy. Незавершённая работа отменяемой ветки прекращается; новый checkpoint
  проверяется отдельно.
- Restore возвращает ровно сохранённое время, automine выключен. Save после успешного возобновления
  возвращает прежнюю настройку automine.

### 4.2 Хранилище и lifecycle

- Один постоянный каталог Panda: служебный журнал, active-generation pointer, snapshots и данные
  каждой generation (EL/BN/shared/VC). В Docker это один явно документированный volume /data/panda;
  локально — ignored каталог Panda.
- EL/BN/shared данные snapshot-capable сессий получают bindmount из собственных generation
  directories. Старые runtime volumes автоматически не мигрируются; новая функциональность
  включается для новой управляемой сети/проверенного snapshot.
- Внутренний dockerd/image cache может пересоздаваться; точные клиентские образы загружаются из
  закреплённых архивов. Snapshot не архивирует dockerd целиком.
- Копирование через scoped helper в Infrastructure сохраняет необходимые права и проверяет пути
  собственной generation. Docker-операции ограничены точным io.panda.id и generation label;
  глобальный prune запрещён.
- Публичный lifecycle определён: owning SDK.close (SDK сам запустил сеть) и CLI down удаляют active
  runtime, snapshots остаются; borrowed SDK.close/disconnect только закрывает клиентское подключение
  и не останавливает общий service; reset создаёт fresh generation. Persistent Docker service при
  SIGTERM выполняет stop-preserve и verified checkpoint вместо destructive Controller.close в
  finally. Следующий старт использует active pointer, а не безусловный fresh genesis. Graceful
  shutdown имеет документированный бюджет; если его не хватило/процесс убит, состояние отмечается
  unclean, lossless resume не объявляется.
- Сохранённые snapshots переживают down/reset; удаление только явное.
- Чистая остановка даёт проверенный resume checkpoint. После SIGKILL наличие файлов не считается
  достаточным: вход остаётся закрыт, при недоказуемом состоянии требуется явное восстановление
  сохранённого snapshot. Не происходит скрытого отката на старую точку.

### 4.3 Входящие запросы и SDK

- Постоянный HTTP-сервис содержит сменяемую NetworkSession: manifest, Timeline, Automine, EngineGate
  и клиенты.
- Пользовательские EL/CL/VC URL стабильны. Локальный запуск и Docker используют один механизм
  управляемых HTTP-frontends. Они считают активные запросы и закрывают SSE при замене сессии.
- Внутренние upstream/clock ports остаются localhost-only в приватном runtime manifest, поскольку
  нужны host-controller на Docker Desktop. Публичный manifest и SDK их не выдают. Собственные
  fixtures переводятся на managed endpoints для пользовательских операций.
- Только новые managed-ingress generations или проверенный checkpoint получают snapshot capability:
  неизвестные принятые запросы старой живой сети нельзя восстановить задним числом.
- Конкурентный прямой доступ локального администратора к внутренним портам во время checkpoint не
  поддерживается. Это не защита от владельца компьютера.
- Lifecycle/operation status остаётся доступен во время maintenance/fault без RPC к остановленным
  клиентам и без Timeline.assertHealthy; показывает phase/result/error, readiness=false до publish.
  Он нужен SDK для восстановления результата потерянного HTTP-ответа.
- Maintenance закрывает приём новых операций, завершает уже принятые конечные запросы и отключает
  automine вне Timeline lock. Save при неуспешном drain отказывает; не копирует неопределённое
  состояние.
- Узкий durable EL admission ledger: intent перед upstream, hash/result до успешного ACK.
  Учитываются batches, notifications и неизвестный transport outcome. Записи завершаются при
  canonical receipt, доказанном consumed nonce либо доказанном pre-admission rejection. Отдельное
  terminal rejected допускается только по проверенной классификации exact pinned Geth (invalid
  signature/invalid transaction и подтверждённые reject cases); произвольный RPC error не считается
  доказательством отсутствия приёма. Accepted/ambiguous остаются unresolved. Записи не пропадают
  только потому, что txpool стал пустым. Автоматической повторной отправки транзакций нет.
- Публичные операции: create/list/restore/remove и start-from-snapshot. Archive import/export и
  перенос между хостами отложены.
- SnapshotRef — многоразовый снимок. Operation ID — один запрос. Повтор ID+payload возвращает
  прежний результат; тот же ID с другим payload отклоняется; новый ID восстанавливает тот же снимок
  заново.
- После restore меняется generation; собственные SDK waits завершаются с понятной ошибкой, filter
  IDs/SSE сбрасываются. Чужие библиотеки не объявляются автоматически очищенными.

### 4.4 Fork schedule

- Profile/bake продолжают выбирать семейство бинарников. ActiveFork — отдельное поле status. По
  умолчанию прежний single-fork genesis сохраняется.
- Целевая переходная сеть с самого начала использует набор с поддержкой Gloas, но начинает с
  Electra/Prague. Первый путь: Electra/Prague → Fulu/Osaka → Gloas/Amsterdam.
- Schedule неизменяем после genesis и при restore. Один compiler создаёт CL epochs/versions и EL
  timestamps. Отдельные pre-Gloas/Gloas churn constants; uint64/disabled epochs без потери точности;
  реальные devnet fork versions записываются в identity.
- Первый выпуск не меняет бинарники на границе. Новый schedule не требует нового образа; изменение
  native поддержки требует нового immutable bake.
- Исторические блоки, состояния и finalized checkpoint интерпретируются по собственному
  fork/version/slot, а не текущему head.
- Honest transitions обязательны. До поддержки fast crossing — явный отказ до любой мутации.
  Завершённая fast поддержка описана в P8.

### 4.5 Подписи и внешний мир

- Restore — откат одноразовой изолированной тестовой ветки с подконтрольными devnet ключами. Внутри
  каждой ветки реальная BLS/slashing protection остаётся включённой.
- Разные подписанные ветки с одинаковыми ключами/genesis нельзя смешивать. Один активный экземпляр
  lineage гарантируется только в управляемом хранилище; глобальная блокировка копий на других
  компьютерах не обещается.
- Проверить validator definitions: только local keystores, paths внутри принадлежащих Panda mounts,
  полный key/password/slashing набор. Remote signer definitions и внешние bind paths отклоняются.
- Импорт arbitrary external signer/key ownership не может быть установлен Panda. Для snapshot mode
  используются объявленные disposable тестовые ключи; remote signers/внешние VC исключены, и их
  конфигурации проверяются. Документированная ответственность не выдаётся за математическое
  доказательство эксклюзивного владения.
- Базы внешних оракулов и индексаторов не входят в снимок. P9 даёт готовую fixture и выполняет её
  тест; пользователю не оставляется задача самостоятельно придумать порядок.

## 5. Этапы, зависимости и условия завершения

### P0. Зафиксировать проверяемые входы и полный состав состояния.

**Зависимости:** нет.

**Исполнитель:** bake/native + controller.

Работы:

- Сверить фактические image IDs/platforms с manifests, извлечь source/build metadata. Для modified
  Geth получить полный diff; если получить невозможно — выбрать согласованный полный commit и
  собрать новый immutable EL с явными patches. Не заменять текущие tags.
- Проверить genesis shell/templates и сам CL genesis binary отдельно. Найденный shell совпадает с
  source 51fb77af..., binary revision 9bbbf55fa9603b4c2e656fe7c441a340ea61f6d6; связать это с
  выбранными входами.
- Составить state inventory обоих профилей: EL databases/ancients/blob data/accepted work; BN
  hot/cold DB, forkchoice queues, op_pool/naive/sync/PTC/custody; VC
  keys/definitions/secrets/slashing; controller clock/session/admission.
- Для каждого элемента выбрать «сохранить», «достоверно завершить до checkpoint», «воссоздать без
  подписей», «запретить до save». Pending и retained already-included user CL operations перечислить
  явно и различить по текущему state. Pending envelopes/DA должны быть завершены либо checkpoint
  отказывает; missing persisted op_pool при restore — ошибка.
- Зафиксировать версии snapshot schema, checkpoint/clock ABI, capability matrix; старый bake без
  capability не выдаёт фиктивную поддержку. **Готовность:** inventory без неназначенных важных
  элементов; exact build inputs либо конкретная новая сборка; список проверок и ожидаемые
  наблюдаемые результаты. Это не gate, требующий уже работающего fork transition.

### P1. Добавить минимальные воспроизводимые регрессии.

**Зависимости:** P0.

**Исполнитель:** native/test.

Работы:

- Native PTC test через существующий Lighthouse harness: настоящие BLS сообщения, обычный
  import/verification, непустой pool, production serialize/decode, payload attestations следующего
  слота. Проверить data/signatures и полные PTC bits, включая повторяющиеся committee indices.
  Использовать подписывающий native harness, не helper с Signature::empty().
- Аналогичные target checks для naive pools и FC queue определяют, что реально теряется на выбранном
  cut. Не добавлять persistence для безвредных пересоздаваемых кешей только из-за default().
- Узкий реальный stop/restart fixture работает напрямую с теми же клиентскими данными и точным
  clock; не использует будущий snapshot API для доказательства snapshot. Сначала BN/VC restart при
  работающем EL для локализации, затем полный stop EL/BN/VC. Отсутствующий API/import не считается
  red.
- Существующий генератор запускается с будущим schedule и проверяется полученный genesis/config;
  static controller behavior получает focused phase/decoder regression.
- Для EL admission воспроизводятся deferred/неоднозначные outcomes на фактически выбранном клиенте и
  потеря ACK. Отдельно доказанный invalid/rejected tx не блокирует create, а unknown outcome
  блокирует. Не объявлять research-source риск багом образа до воспроизведения. **Готовность:**
  сохранённые команды, pin/key и наблюдаемые red результаты; проверки без реальной поломки отмечены
  как coverage, а не сфабрикованный red.

### P2. Подготовить lifecycle, постоянное хранилище и управляемый вход.

**Зависимости:** P0; релевантные red из P1.

**Исполнитель:** controller/Docker.

Работы:

- Разделить initialize-new/open-existing, stop-preserve/destroy; постоянный service и сменяемую
  session. Привязать к публичным SDK.close/down/reset и persistent service SIGTERM/restart согласно
  4.2; исключить удаление durable state из прежнего finally. Отдельные regressions на каждый
  lifecycle entrypoint, включая owning close и borrowed close: первый удаляет только принадлежащий
  active runtime, второй оставляет shared service работающим.
- Реализовать layout generation bindmounts, ownership/path checks и helpers копирования. Исключить
  использование свежего genesis при resume.
- Общий maintenance/operation lock вне Timeline; корректный drain автомайна/запросов, отмена faulted
  ветки для restore; managed EL/CL/VC frontends. Независимый status/operation endpoint доступен и
  при неработающих клиентах; readiness отражает lifecycle, не висит на их RPC.
- EL admission ledger с terminal confirmed/consumed/rejected и unresolved, проверенная классификация
  отказов; перевод всех supported user ingress/fixtures на frontends. **Готовность:** гонки
  save/advance/automine/import/shutdown не deadlock; acknowledged work не исчезает; незавершённый
  drain даёт отказ; другая сеть не затронута. Native полнота продолжения ещё не считается
  доказанной.

### P3. Сделать lossless native checkpoint и проверенный cold resume.

Текущая работа над сохранением PTC и naive attestations, с RED/GREEN и границами проверки:
[отчёт по persistence](snapshots-p3-persistence.md). Это часть P3; checkpoint ACK, admission/drain и
parked startup остаются отдельными требованиями ниже.

**Зависимости:** P0/P1/P2.

**Исполнитель:** Lighthouse native + controller.

Работы:

- Добавить явный Panda checkpoint с подтверждением успешной записи, а не разбор одного exit code.
  Native writers/queues завершаются на согласованном cut; записываются фактические roots, FC slot,
  время и нужные protocol pools.
- Версионированные дополнительные checkpoint данные в BN storage сохраняют PTC и другие необходимые
  буферы из inventory. Поддержанные пользовательские CL pools проходят сохранение/загрузку и
  проверку дальнейшего включения ровно один раз; included-retained операции не считаются
  неподтверждёнными. Pending envelopes/DA и неизвестные in-flight buffers нельзя молча отбросить.
  Применяются обычные правила верификации; поддельные marks, пустые замены и отключение BLS
  запрещены. Несогласованный/незавершённый checkpoint не считается usable.
- Startup на сохранённом времени с parked duties до явного продолжения. EL/BN согласуются, VC
  открывает существующую slashing DB без --init-slashing-protection. Missing/повреждённая БД —
  отказ. Transient Engine payload IDs/сетевые handles/marks создаются заново, не копируются как
  доказательство выполненной работы.
- Чистая остановка VC→BN→EL с сохранением данных; реальный bounded watchdog без признания
  force-killed checkpoint успешным.
- Собрать новые native bakes для изменённых профилей, запускать native tests в составе сборки;
  повторная сборка только при изменении native inputs.
- Реальный stop/resume Gloas (Pectra отложена): одинаковые сохранённые
  time/roots/checkpoints/signing history; затем следующий блок, полное участие, economics,
  транзакция и финальность. **Готовность:** restart не теряет continuation. Reference — отдельно
  запущенная свежая сеть с теми же входами, без использования новой snapshot реализации; проверка
  подписей/переходов обычным pinned кодом. Равенство будущих hashes ожидается только при идентичных
  block inputs; правила сравнения фиксируются до теста, не ослабляются после mismatch.

### P4. Реализовать durable snapshot create.

**Зависимости:** P2/P3.

**Исполнитель:** controller/storage.

Работы:

- Общий gate/drain, проверка healthy/cut/pending EL admission/полноты CL checkpoint; capture anchors
  после drain. Ожидаемые roots/storage/receipts/balances/SSZ state в тесте читаются напрямую до
  snapshot независимо от manifest, который создаёт новая реализация.
- Native checkpoint и чистая остановка, копирование только остановленных баз в temp snapshot.
  Manifest: schema/ABI, точные images/platform, bakeKey, genesis/schedule/versions/constants, time,
  EL/CL roots/checkpoints, file inventory/checksums.
- В snapshot не попадают старые PID/locks/ports/host paths/transient handles. Права приватные;
  snapshot не входит в Git и обычную загрузку CI logs.
- Atomic publication, затем resume исходной сети. Если snapshot уже сохранён, а resume упал:
  structured failure содержит snapshot ID, состояние stopped; снимок остаётся видимым и пригодным.
  **Готовность:** неизменяемый многоразовый артефакт, никаких скрытых блоков/времени;
  disk-full/copy/persistence failures не публикуют повреждённый snapshot.

### P5. Реализовать restore, recovery и публичные команды.

**Зависимости:** P4.

**Исполнитель:** controller/API/CLI/container.

Работы:

- До остановки рабочей сети проверить manifest, checksums, совместимость и место на диске; запретить
  chain/schedule overrides.
- Restore работает и для faulted сети. Подготовить отдельную generation, не распаковывать поверх
  active данных. Старые signers остановлены.
- Запустить восстановленные клиенты parked, проверить реальные anchors/pools/keys/clocks до
  публикации. Readiness не майнит блок и не отправляет тестовую транзакцию.
- Durable operation journal + active pointer; commit/publish/cleanup. До commit прежняя generation
  остаётся authoritative; после commit — новая. Здоровую исходную сеть можно вернуть только после
  проверки; faulted исходник ready не объявляется. После опубликованных новых подписей
  автоматический возврат назад запрещён.
- После SIGKILL startup восстанавливает стадию, но не предполагает согласованный active checkpoint
  только по наличию БД. При недоказуемом cut service сообщает recovery-required и ждёт явного
  restore выбранного снимка.
- Retry semantics: same operation ID+payload не выполняет restore повторно; новый ID к тому же
  snapshot выполняет. Удаление используемого snapshot запрещено.
- SDK/CLI create/list/restore/remove/start-from-snapshot используют один механизм. Docker mount
  /data/panda и stable endpoints проверены; local SDK объект переживает замену session.
  **Готовность:** create→mutate→restore→mutate→restore; faulted network→restore→next tx/finality;
  process/container loss; lost HTTP response до/после commit; corrupt/missing files; чужие ресурсы
  сохранены. Recovery table покрывает каждую стадию.

### P6. Сделать расписание и согласованный genesis.

**Зависимости:** P0/P1. Может разрабатываться независимо от artifact API P4/P5.

**Исполнитель:** config/genesis.

Работы:

- Типизированный immutable schedule поддерживаемых пар форков; register capability отдельно от
  profile/bake.
- Один compiler генерирует CL epochs/fork versions, CL blob schedule, BPO epochs и все EL
  timestamps, раздельные churn constants и exact uint64. Проверить порядок Osaka/BPO до Docker
  mutation; не наследовать дефолтный BPO epoch 0 при будущем Fulu.
- Реальный standalone genesis generator, geth init, decode CL genesis state точной версией: старт
  действительно Electra, будущие Fulu/Gloas не активированы раньше времени.
- Если generator/EL/CL несовместимы: локализовать компонент, закрепить известный source/patchset,
  создать новый bake и повторить проверки. Не переключать silently на другой fork. **Готовность:**
  валидные согласованные EL+CL genesis artifacts с будущим schedule. Здесь не требуется заранее
  работающий Deno dynamic transition.

### P7. Реализовать честные переходы.

**Зависимости:** P6, необходимые P2/P3 native capabilities.

**Исполнитель:** native/time/consensus.

Работы:

- Resolver активного fork по слоту; Timeline phases и Consensus expectations динамические. Clock
  marks выбираются также по ABI бинарника.
- Engine capability preflight для всего пути; правильные payload/envelope/PTC/finality rules.
  Historical decoder использует объект, включая pre-fork finalized при post-fork head.
- Native component regressions на границах, PTC service awakening перед Gloas, domains и cache
  invalidation, proposer/attester/sync duties. Voluntary exit domain проверяется по исключению
  EIP-7044.
- Изменённые native inputs собираются в новый immutable bake; затем минимальный полный вертикальный
  срез до первой границы, реальный первый переход и следующий. Нет кругового требования «сначала
  пройти переход, потом реализовать его adapters».
- Отдельно Electra→Fulu, Fulu→Gloas и вся цепочка; реальные blob tx/DA до и после Fulu; операции
  протокола через границы, economics, signing и финальность. **Готовность:** реальный переход в
  одной цепочке без замены binaries, согласованные EL/CL и корректные исторические запросы. Каждая
  рекламируемая пара проверена точными image identities.

### P8. Добавить fast crossing с точным временем.

**Зависимости:** P7.

**Исполнитель:** time/native.

Работы:

- До поддержки crossing — reject полного unsupported диапазона до изменения часов/VC.
- После поддержки разбить skip по всем границам; последний pre-fork slot и первый post-fork epoch
  обрабатываются honest. Пересекающиеся окна объединяются.
- Окно применяется только к пересечению с [current,target]; requested timestamp никогда не
  превышается. Следующие fast-команды, начавшиеся внутри окна, тоже выполняют честную часть.
- Небезопасное начальное состояние отклоняется до mutation; проверенный recovery путь реализуется
  явно.
- Проверить mid-slot/exact boundary/несколько границ, первый tx после скачка, signing и resumed
  finality. Сохранить существующие non-crossing budgets; время crossing измерить и до оптимизации
  закрепить бюджет. Honest часть не превращает весь skipped диапазон в penalty-free. **Готовность:**
  fast корректно проходит поддержанные переходы, не скрывает дополнительного времени; неподдержанное
  не выполняется частично.

### P9. Соединить функции и подготовить реальную fixture потребителя.

**Зависимости:** P5/P7/P8.

**Исполнитель:** integration/SDK docs.

Работы:

- Снимки до, после и внутри boundary window; переход→restore→повторный переход; чтение старых
  блоков/доказательств после post-fork restore.
- Реальные deposit/activation/consolidation/exit/withdrawal через snapshot и fork с проверкой
  очередей, балансов и фактических EL выплат, без дублирования внутри каждой ветки.
- Fixture: остановить consumer; restore; пересоздать provider/nonce cache; очистить отдельный
  cursor/database; выполнить полный replay от известного deployment/start block (либо genesis) до
  восстановленного head. Одна точка snapshot не заменяет предшествующую историю. Реальный отдельный
  процесс до restore должен обработать будущее; после replay проверяются одновременно
  восстановленные данные ДО snapshot и отсутствие данных отброшенного будущего. **Готовность:**
  сценарий используется как готовый пример для CL-зависимых тестов. Это не обещание автоматически
  откатывать произвольные внешние БД и не правки чужого проекта без отдельной задачи.

### P10. Выпускная проверка и документация.

**Зависимости:** все предыдущие.

**Исполнитель:** CI/bake/test.

Работы:

- Зарегистрировать новые scenarios/fingerprints/capabilities в существующих runners; unit/format
  tests отделены от реальных EL/CL scenarios. Old tags не переписываются, unsupported capability не
  помечается passed.
- deno task check/test; Docker/baker/lifecycle проверки; полные применимые test:profile для каждого
  поставляемого Gloas bake; packaged service и новая transition matrix. Pectra отложена. Сборка
  отдельна от запуска тестов.
- Последовательные real-network проверки, включая существующие honest 1000 и fast 8192 сценарии и
  протокольные suites; не устраивать параллельную нагрузку с измерениями.
- Измерить save/restore downtime, размер снимка, объём дополнительного диска и время первого tx
  после возврата. Время не обещается заранее.
- README: требования, snapshot scope/persistence/recovery, schedule, reset внешнего consumer,
  private data policy, понятные ошибки. Публичные результаты без личных путей/секретов.
  **Готовность:** нет незакрытого обязательного gate; все результаты привязаны к exact
  bake/image/schema/ABI/schedule/suite. Сборка либо отдельный unit pass не выдаются за
  работоспособность целой фичи.

## 6. Восстановление после сбоя

- До начала maintenance: active сеть продолжает работать; неверный snapshot/параметр ничего не
  меняет.
- Drain/capture: новый usable snapshot ещё не опубликован. При неуверенности fail; исходник
  возобновляется только после доказанного checkpoint, иначе stopped/recovery-required.
- Snapshot опубликован, original resume упал: snapshot доступен; операция явно сообщает частичный
  успех и stopped network.
- Restore staged, до commit: старая generation authoritative, candidate не подписывает. Candidate
  удаляется/исследуется; старая не запускается вслепую, особенно если была faulted.
- После durable commit: новая generation authoritative. Повтор HTTP запроса возвращает записанный
  результат/стадию; не выполняет второй restore. Публикация endpoints восстанавливается для новой
  generation.
- После publish/новых подписей: автоматического отката к старой ветке нет. Ошибка cleanup сообщается
  отдельно, текущая цепочка остаётся authoritative.
- Unclean process/container loss с persistent root: journal/data сохраняются; это не доказательство
  lossless active resume. При отсутствии проверенного cut нужен явно выбранный сохранённый snapshot.
- Ephemeral запуск без сохранённого root: удаление контейнера удаляет его данные. Документация
  показывает persistent режим для заявленной долговечности.

## 7. Карта основных изменений

src/network.ts и src/docker.ts — open-existing/stop-preserve, generation storage/ownership/copy.
src/controller.ts, src/api.ts, src/cli.ts, container/main.ts, container/relay.ts — stable frontends,
session replacement, operation/recovery API, durable mount. src/config.ts и src/profiles.ts —
schedule, capabilities, native ABI и совместимость snapshot. src/time.ts, src/consensus.ts,
src/engine.ts — active fork, barriers, historical decoding, restart/time handling.
bakes/*/lighthouse.patch, bakes/shared/controlled_clock.rs и необходимые native helpers — checkpoint
persistence/parked startup/fork duties. Все inputs входят в bake key. bakes/shared/tests и
bakes/gloas/tests — настоящие resume/snapshot/transition/consumer scenarios; tests — unit границы
config/storage/adapters без выдачи mock за совместимость сети. src/verification.ts и
scripts/test_profile.ts — fingerprint/matrix и честные capabilities.

## 8. Результат ревью

| Направление                                          | Решение по редакции 4               |
| ---------------------------------------------------- | ----------------------------------- |
| Снапшоты, сохранность состояния и подписи            | Одобрено, блокирующих замечаний нет |
| Переходы между форками и совместимость клиентов      | Одобрено, блокирующих замечаний нет |
| Порядок реализации, API и восстановление после сбоев | Одобрено, блокирующих замечаний нет |

Одобрение относится к плану, зависимостям и критериям готовности. Оно не подтверждает
работоспособность будущей реализации и не заменяет перечисленные проверки.
