import type { ModuleRelations, RelationPeer, Site } from "../../../framework/module-relations/types.js";
import { el } from "./dom.js";
import { openDiffDialog } from "./diff.js";
import { errorMessage } from "../types.js";

function places(n: number) {
  const ending = new Intl.PluralRules("ru").select(n);
  return n + " " + (ending === "one" ? "место" : ending === "few" ? "места" : "мест");
}

function textButton(text: string, action: () => void) {
  const button = el("button", "relation-link", text);
  button.type = "button";
  button.onclick = action;
  return button;
}

type OpenSite = (owner: string, site: Site) => void;

export async function openRelationSource(site: Site, load: () => Promise<{text: string}>) {
  const dialog = openDiffDialog(site.file + ":" + site.line);
  dialog.classList.add("file-diff-dialog");
  const body = el("div", "relation-source", "Загрузка…");
  dialog.append(body);
  try {
    const {text} = await load();
    if (!dialog.open) return;
    const lines = text.split("\n");
    const mark = el("mark", "", lines[site.line - 1] || " ");
    const pre = el("pre", "");
    pre.append(document.createTextNode(lines.slice(0, site.line - 1).join("\n") + (site.line > 1 ? "\n" : "")),
      mark, document.createTextNode("\n" + lines.slice(site.line).join("\n")));
    body.replaceChildren(pre);
    mark.scrollIntoView({block:"center", inline:"nearest"});
  } catch (cause) { body.textContent = errorMessage(cause); }
}

export function renderRelations(body: HTMLElement, data: ModuleRelations, owner: string, openModule: (dir: string) => void, openSite: OpenSite) {
  if (!data.ready) {
    body.append(el("p", "empty-state", "Связи ещё не построены для этого снимка. Индексатор поддерживает TypeScript и JavaScript."));
    return;
  }
  const coverage = el("p", "relations-coverage", "TypeScript / JavaScript · файлов в индексе: " + data.indexed + " из " + data.eligible);
  if (data.indexed < data.eligible) coverage.append(" · Частичное покрытие");
  body.append(coverage);
  function section(heading: string, peers: RelationPeer[], outgoing: boolean) {
    const section = el("section", "relations-group");
    section.append(el("h3", "", heading + " · " + peers.length));
    if (!peers.length) section.append(el("p", "relations-coverage", "В проиндексированном коде связей не найдено."));
    for (const peer of peers) {
      const details = el("details", "relation-peer");
      const summary = el("summary", "");
      summary.append(textButton(peer.name, () => openModule(peer.directory)), el("span", "relation-count", places(peer.count)));
      details.append(summary);
      // Large modules may have thousands of uses. Construct evidence only when expanded.
      details.addEventListener("toggle", () => {
        if (!details.open || details.childElementCount > 1) return;
        for (const symbol of peer.symbols) {
          const item = el("details", "relation-symbol");
          const label = el("summary", "");
          label.append(el("code", "", symbol.name), el("span", "relation-count", places(symbol.uses.length)));
          item.append(label);
          item.addEventListener("toggle", () => {
            if (!item.open || item.childElementCount > 1) return;
            const target = symbol.definition;
            item.append(textButton("Объявление · " + target.file + ":" + target.line, () => openSite(outgoing ? peer.directory : owner, target)));
            for (const use of symbol.uses) {
              const row = el("div", "relation-use");
              row.append(textButton(use.file + ":" + use.line + ":" + use.column, () => openSite(outgoing ? owner : peer.directory, use)),
                el("code", "", use.text));
              item.append(row);
            }
          });
          details.append(item);
        }
      });
      section.append(details);
    }
    body.append(section);
  }
  section("Использует напрямую", data.outgoing, true);
  section("Напрямую используется в", data.incoming, false);
}
