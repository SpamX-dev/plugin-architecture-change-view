# plugin-architecture-change-view

MCP-сервер правил ведения module.md. Канонический скилл находится в
[skills/module-boundaries/SKILL.md](skills/module-boundaries/SKILL.md) и выдаётся
без изменений как ресурс skill://module-boundaries по
[контракту skill://](https://github.com/SpamX-dev/dsh-skills-over-mcp-plugin/blob/main/CONTRACT.md).

Правило покрытия: module.md нужен в каждом каталоге с исходным кодом, включая
вложенные каталоги, тесты, скрипты и общие каталоги дерева исходников. В документе
фиксируются ответственность, границы и устойчивые ограничения. Изменение
реализации само по себе не является основанием расширять эту ответственность.

## Запуск

Node.js 22 или новее:

~~~powershell
npm ci
node src/server.mjs --root D:/path/to/project
~~~

Корень берётся из --root, PLUGIN_ARCHITECTURE_CHANGE_VIEW_ROOT или рабочего каталога процесса.
Один процесс обслуживает один явно выбранный проект.

## Инструменты

| Инструмент | Вход | Результат |
| --- | --- | --- |
| module_inventory | {} | Каталоги дерева исходников и покрытие описаниями |
| module_context | {"directory":"src/domain"} | Контракты от корня до целевого каталога |

Инструменты только читают файлы. ИИ пишет module.md своими файловыми
инструментами после изучения локального кода и родительских границ.

module_inventory возвращает schema_version, root, complete, discovery,
sourceFiles, modules и diagnostics. У модуля есть directory, document, status,
sourceFiles и required. sourceFiles считает исходники всего поддерева;
required означает, что каталог содержит исходники непосредственно или ниже.
Статусы: documented, missing, empty, unreadable. Каталог с module.md и без
исходников остаётся видимым с required: false — это позволяет описывать
согласованные планируемые блоки.

В Git используются отслеживаемые и неигнорируемые неотслеживаемые файлы; удалённые
файлы пропускаются. Вне Git действует файловый обход. Символические ссылки не
расширяют дерево анализа. Обычные каталоги зависимостей и сборки исключены в
обоих режимах: .git, .hg, .svn, node_modules, target, dist, build, coverage,
.venv, venv, __pycache__, .next, .nuxt, .cache, obj.

Исходники определяются по расширениям из src/inventory.mjs; дополнительные
расширения можно передавать повторяемым --extension .ext. Вне Git произвольные
.gitignore не интерпретируются. Это проверка структуры, а не определение
семантических модулей через AST.

Обход ограничен 50 000 учитываемых файлов, настраивается через --max-files.
Ошибка чтения или достижение лимита возвращает complete: false с диагностикой.
Один module.md ограничен 128 KiB. Наличие непустого файла не доказывает
содержательную корректность границ.

## dsh

Существующий dsh-skill-mcp менять не требуется. Используйте тот же serverName
в подключении MCP и в allow-list провайдера скиллов:

~~~yaml
- name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: plugin-architecture-change-view
    transport: stdio
    command: node
    args:
      - D:/projects/dsh.plugins/plugin-architecture-change-view/src/server.mjs
      - --root
      - D:/path/to/project

- name: '@deepseek-ai/dsh-skill-mcp'
  config:
    servers: ['plugin-architecture-change-view']
~~~

Если allow-list уже содержит ast-index, добавьте plugin-architecture-change-view в тот же
список. Второй экземпляр адаптера не требуется.

## Codex

Codex использует файловые скиллы. Экспортируйте ресурс через
[codex-skill-over-mcp](https://github.com/SpamX-dev/codex-skills-over-mcp#readme) в
каталог .agents/skills целевого репозитория.

Экспорт скилла и подключение инструментов — два отдельных действия.
Пример проектной конфигурации .codex/config.toml:

~~~toml
[mcp_servers.plugin-architecture-change-view]
command = "node"
args = [
  "D:/projects/dsh.plugins/plugin-architecture-change-view/src/server.mjs",
  "--root",
  "D:/path/to/project",
]
~~~

Скилл описывает инструменты независимо от префиксов клиента и содержит путь
работы через файловые средства при недоступном сервере.

Скилл задаёт поведение агента; он не гарантирует применение во всех запросах.
Для обязательного применения закрепите в AGENTS.md проекта правило:
«При создании, изменении или перемещении исходного кода используй скилл
module-boundaries и соблюдай module.md целевого каталога и его предков».

Официальные описания:
[обнаружение файловых скиллов](https://learn.chatgpt.com/docs/build-skills),
[подключение MCP](https://developers.openai.com/codex/mcp/).

## Проверка

~~~powershell
npm test
~~~

Проверяются реальные stdio-вызовы, совпадение ресурса с файловым скиллом,
вложенное покрытие, родительские контракты, Git ignores, неполный обход и
ограничение файловой области.

Сравнение семантических снимков, эвристический вывод ответственности и
сопоставление изменений с принятой ответственностью относятся к следующему
этапу. Этот сервер предоставляет исходный контракт для таких проверок.
