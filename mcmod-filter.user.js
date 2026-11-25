// ==UserScript==
// @name         MC 百科内容屏蔽
// @namespace    https://www.mcmod.cn/
// @version      0.4.2
// @description  屏蔽 MC 百科的模组、整合包、作者、评论用户和评论正文。
// @homepageURL  https://github.com/MX703DR/mcmod-filter
// @supportURL   https://github.com/MX703DR/mcmod-filter/issues
// @updateURL    https://raw.githubusercontent.com/MX703DR/mcmod-filter/main/mcmod-filter.user.js
// @downloadURL  https://raw.githubusercontent.com/MX703DR/mcmod-filter/main/mcmod-filter.user.js
// @match        https://www.mcmod.cn/*
// @match        https://mcmod.cn/*
// @match        https://search.mcmod.cn/*
// @run-at       document-end
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      www.mcmod.cn
// ==/UserScript==

(() => {
    'use strict';

    function installUi(api) {
        const title = 'MC 百科内容屏蔽';
        const badgeKey = 'mcmod-filter-badge-v1';
        const names = { mod: '模组', pack: '整合包', author: '作者', comment: '评论用户' };
        const sections = [
            ['base', '⚙ 基础'], ['black', '🚫 黑名单'], ['advanced', '🛰 进阶'],
            ['comments', '💬 评论'], ['allow', '⭐ 白名单'], ['tools', '🧰 工具'],
        ];
        const projects = ['modWords', 'modIds', 'packWords', 'packIds', 'authorWords', 'authorIds', 'authorUids'];
        const comments = ['userWords', 'userUids', 'commentWords'];
        const lists = new Map();
        const state = () => api.current().raw;
        let tab = 'base';
        let panel;
        let groups;
        let tabs;
        let query;
        let searchCount;
        let focusBeforePanel;
        let menu;
        let hover;
        let hoverTarget;
        let hoverFrame;
        let pointerTarget;
        let refreshLog;
        let logOpen = false;
        let currentDialog;
        let badgePosition = parsePosition(GM_getValue(badgeKey, null));
        let drag;
        let ignoreBadgeClick = false;

        const control = (label, action, className = '') =>
            make('button', label, { type: 'button', className, onclick: action });
        const uiNode = (tag, id, className = '') => {
            const node = make(tag, '', { id, className });
            node.dataset.mcfUi = '';
            return node;
        };
        const badge = uiNode('button', 'mcf-badge');
        badge.type = 'button';
        const messages = uiNode('div', 'mcf-messages');
        messages.setAttribute('aria-live', 'polite');
        document.body.append(badge, messages);

        function parsePosition(value) {
            try {
                const point = typeof value === 'string' ? JSON.parse(value) : value;
                if (Number.isFinite(point?.left) && Number.isFinite(point?.top)) return point;
            } catch {
                return null;
            }
            return null;
        }

        function positionBadge(point) {
            if (!point || state().lockBadgePosition) {
                badge.style.left = badge.style.top = '';
                badge.style.right = badge.style.bottom = '';
                return null;
            }
            const { width, height } = badge.getBoundingClientRect();
            const maxX = Math.max(0, innerWidth - width);
            const maxY = Math.max(0, innerHeight - height);
            const fit = (value, limit) => Math.min(Math.max(value, Math.min(8, limit)), Math.max(0, limit - 8));
            const next = { left: fit(point.left, maxX), top: fit(point.top, maxY) };
            Object.assign(badge.style, { left: next.left + 'px', top: next.top + 'px', right: 'auto', bottom: 'auto' });
            return next;
        }

        badge.addEventListener('pointerdown', (event) => {
            if (state().lockBadgePosition || drag || !event.isPrimary || event.button !== 0) return;
            const rect = badge.getBoundingClientRect();
            drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
            badge.setPointerCapture?.(event.pointerId);
        });

        badge.addEventListener('pointermove', (event) => {
            if (drag?.id !== event.pointerId) return;
            const dx = event.clientX - drag.x;
            const dy = event.clientY - drag.y;
            if (!drag.position && Math.hypot(dx, dy) < 5) return;
            drag.position = positionBadge({ left: drag.left + dx, top: drag.top + dy });
            badge.classList.add('is-dragging');
        });

        function finishDrag(event) {
            if (drag?.id !== event.pointerId) return;
            if (drag.position) {
                badgePosition = drag.position;
                GM_setValue(badgeKey, badgePosition);
                ignoreBadgeClick = true;
                setTimeout(() => { ignoreBadgeClick = false; }, 0);
            }
            drag = null;
            badge.classList.remove('is-dragging');
        }

        badge.addEventListener('pointerup', finishDrag);
        badge.addEventListener('pointercancel', finishDrag);
        badge.onclick = () => { if (!ignoreBadgeClick) openPanel(); };
        window.addEventListener('resize', () => positionBadge(badgePosition));

        function toast(message, undo, error = false) {
            if (!state().showNotifications) return;
            const item = make('div', '', { className: error ? 'mcf-toast is-error' : 'mcf-toast' });
            const timer = setTimeout(() => item.remove(), undo ? 6500 : 4200);
            const close = () => { clearTimeout(timer); item.remove(); };
            item.append(make('span', message));
            if (undo) item.append(control('撤销', () => { close(); undo(); }, 'mcf-toast-action'));
            item.append(control('×', close, 'mcf-icon'));
            messages.replaceChildren(item);
        }

        function setOptions(patch) {
            api.commit({ ...state(), ...patch });
        }

        function setLists(edits, patch) {
            setOptions({ ...patch, ...Object.fromEntries(Object.entries(edits).map(([field, values]) =>
                [field, values.join('\n')])) });
        }

        function addRules(field, entries) {
            const old = api.current().lists[field];
            const added = [...new Set(entries)].filter(value => !old.includes(value));
            if (added.length) setLists({ [field]: [...old, ...added] });
            return added;
        }

        function removeRules(field, values) {
            const selection = new Set(values);
            const list = api.current().lists[field];
            const removed = list.flatMap((value, index) => selection.has(value)
                ? [{ value, index, disabled: state().disabled[field].includes(value) }] : []);
            if (removed.length) setLists({ [field]: list.filter(value => !selection.has(value)) });
            return removed;
        }

        function restoreRules(field, removed) {
            const items = [...api.current().lists[field]];
            const disabled = new Set(state().disabled[field]);
            for (const row of removed) {
                if (items.includes(row.value)) continue;
                items.splice(row.index, 0, row.value);
                if (row.disabled) disabled.add(row.value);
            }
            setLists({ [field]: items }, { disabled: { ...state().disabled, [field]: [...disabled] } });
            redrawLists();
        }

        function changeDisabled(field, value) {
            const disabled = new Set(state().disabled[field]);
            if (!disabled.delete(value)) disabled.add(value);
            setOptions({ disabled: { ...state().disabled, [field]: [...disabled] } });
        }

        function allow(pair, label) {
            try {
                if (state().disabled[pair[0]].includes(pair[1])) changeDisabled(...pair);
                else addRules(pair[0], [pair[1]]);
                redrawLists();
                toast('已放行并加入白名单：' + (label || pair[1]));
            } catch (error) {
                toast(error.message, null, true);
            }
        }

        function quickRule(field, value, message) {
            try {
                const added = addRules(field, [value]);
                redrawLists();
                if (added.length) {
                    toast(message, () => { removeRules(field, added); redrawLists(); });
                } else if (state().disabled[field].includes(value)) {
                    changeDisabled(field, value);
                    redrawLists();
                    toast('已重新启用规则：' + value);
                } else {
                    toast('名单中已有这条规则');
                }
            } catch (error) {
                toast(error.message, null, true);
            }
        }

        function ask({ heading, message, submit = '确定', danger = false, choices }) {
            currentDialog?.close('cancel');
            const dialog = uiNode('dialog', 'mcf-confirm');
            dialog.classList.toggle('is-danger', danger);
            const headingNode = make('h3', heading, { id: 'mcf-confirm-title' });
            dialog.setAttribute('aria-labelledby', headingNode.id);
            const text = make('p', message);
            let select;
            if (choices) {
                select = make('select');
                select.setAttribute('aria-label', '作者');
                for (const [index, label] of choices.entries()) select.append(make('option', label, { value: String(index) }));
            }
            const buttons = make('div', '', { className: 'mcf-tools-row' });
            const cancel = control('取消', () => dialog.close('cancel'));
            const confirm = control(submit, () => dialog.close('confirm'), danger ? 'mcf-danger' : 'mcf-primary');
            buttons.append(cancel, confirm);
            dialog.append(headingNode, text);
            if (select) dialog.append(select);
            dialog.append(buttons);
            dialog.onclick = (event) => { if (event.target === dialog) dialog.close('cancel'); };
            document.body.append(dialog);
            currentDialog = dialog;
            const previousFocus = document.activeElement;
            return new Promise((resolve) => {
                dialog.addEventListener('close', () => {
                    const result = dialog.returnValue === 'confirm' ? (select ? Number(select.value) : true) : false;
                    if (currentDialog === dialog) currentDialog = null;
                    dialog.remove();
                    previousFocus?.focus();
                    resolve(result);
                }, { once: true });
                dialog.showModal();
                (danger ? cancel : select ?? confirm).focus();
            });
        }

        function block(info, confirmFirst = false) {
            const field = info.type === 'comment'
                ? (info.uid ? 'userUids' : 'userWords')
                : (info.id ? info.type + 'Ids' : info.uid ? 'authorUids' : 'authorWords');
            const value = info.type === 'comment' ? info.uid || info.name : info.id || info.uid || info.label;
            if (!value) return;
            const noun = names[info.type];
            const run = () => quickRule(field, value, '已屏蔽' + noun + '：' + info.label);
            if (!confirmFirst) { run(); return; }
            ask({ heading: '屏蔽作者', message: '将「' + info.label + '」加入本地黑名单？',
                danger: true, submit: '屏蔽' }).then(ok => { if (ok) run(); });
        }

        async function withAuthor(info, callback) {
            try {
                const rows = (await api.authorsFor(info)).map(item => ({
                    ...item, type: 'author', label: item.names[0] || item.id || item.uid,
                })).filter(item => item.label);
                if (!rows.length) {
                    toast('这个条目没有可识别的作者');
                    return;
                }
                const index = rows.length === 1 ? 0 : await ask({
                    heading: '选择作者', message: info.label, choices: rows.map(item => item.label),
                });
                if (index !== false) callback(rows[index]);
            } catch (error) {
                toast(error.message, null, true);
            }
        }

        function allowInfo(info) {
            const pair = api.passFor(info);
            if (pair) allow(pair, info.label);
        }

        function closeMenu() {
            menu?.remove();
            menu = null;
        }

        function rightClick(event) {
            closeMenu();
            const raw = state();
            if (!raw.enabled || !raw.rightClickBlock || !event.shiftKey) return;
            const info = api.context(event.target);
            if (!info || (info.type === 'comment' && !raw.commentEnabled)) return;
            const actions = [];
            const selected = getSelection()?.toString().replace(/\s+/g, ' ').trim();
            const isComment = info.type === 'comment';
            if (selected && selected.length <= 30) {
                const field = isComment ? 'commentWords' : info.type + 'Words';
                const prefix = isComment ? '🚫 评论含' : '🚫 屏蔽含';
                actions.push([prefix + '「' + selected + '」关键词', () =>
                    quickRule(field, selected, '已加入关键词：' + selected)]);
            }
            if (isComment) {
                if (info.uid || info.name) actions.push(['🚫 屏蔽评论用户「' + info.label + '」', () => block(info)]);
            } else {
                if (info.type === 'pack' || info.type === 'mod') {
                    actions.push(['🚫 屏蔽作者…', () => withAuthor(info, block)],
                        ['⭐ 将作者加入白名单…', () => withAuthor(info, allowInfo)]);
                }
                if (info.id || info.uid) {
                    const noun = names[info.type];
                    actions.push(['🚫 屏蔽此' + noun + '（' + (info.id || info.uid) + '）', () => block(info)],
                        ['⭐ 加入白名单（永不屏蔽此' + noun + '）', () => allowInfo(info)]);
                }
                if (info.card) actions.push(['🙈 隐藏这一张', () => api.addManual(info.target)]);
                actions.push(['⚙️ 打开设置面板', openPanel]);
            }
            if (!actions.length) return;
            event.preventDefault();
            event.stopPropagation();
            menu = uiNode('div', 'mcf-menu');
            for (const [label, run] of actions) menu.append(control(label, () => { closeMenu(); run(); }));
            document.body.append(menu);
            const { width, height } = menu.getBoundingClientRect();
            menu.style.left = Math.max(0, Math.min(event.clientX, innerWidth - width - 8)) + 'px';
            menu.style.top = Math.max(0, Math.min(event.clientY, innerHeight - height - 8)) + 'px';
        }

        function hideHover() {
            hoverTarget = null;
            if (hover) hover.hidden = true;
        }

        function hoverButtons() {
            const host = uiNode('div', 'mcf-hover');
            // Keep hover controls outside the site's card markup and anchor links.
            host.append(control('⛔ 屏蔽作者', () => {
                const info = hoverTarget;
                hideHover();
                if (!info) return;
                if (info.type === 'author') block(info, true);
                else withAuthor(info, author => block(author, true));
            }), control('🚫 不看这个', () => {
                const info = hoverTarget;
                hideHover();
                if (info) block(info);
            }));
            document.body.append(host);
            return host;
        }

        function updateHover(event) {
            if (!state().enabled || !state().cardHoverBtn || hover?.contains(event.target)) return;
            pointerTarget = event.target;
            if (hoverFrame) return;
            hoverFrame = requestAnimationFrame(() => {
                hoverFrame = 0;
                if (!state().enabled || !state().cardHoverBtn) return;
                const info = api.context(pointerTarget);
                if (!info?.card) { hideHover(); return; }
                const box = info.target.getBoundingClientRect();
                if (box.width < 80 || box.height < 60) { hideHover(); return; }
                if (!hover) hover = hoverButtons();
                hoverTarget = info;
                Object.assign(hover.style, { left: Math.max(8, box.left + 8) + 'px', top: Math.max(8, box.top + 8) + 'px' });
                hover.hidden = false;
            });
        }

        function openPanel() {
            if (panel?.classList.contains('is-open')) { panel.focus(); return; }
            if (!panel) createPanel();
            focusBeforePanel = document.activeElement;
            panel.inert = false;
            panel.classList.add('is-open');
            redrawLists();
            refreshLog?.();
            panel.focus({ preventScroll: true });
        }

        function closePanel() {
            if (!panel?.classList.contains('is-open')) return;
            panel.classList.remove('is-open');
            panel.inert = true;
            focusBeforePanel?.focus?.({ preventScroll: true });
        }

        function applySearch() {
            const needle = query.value.trim().toLowerCase();
            let matching = 0;
            for (const [key, group] of groups) {
                for (const box of group.children) {
                    const match = !needle || (box.dataset.search || box.textContent).toLowerCase().includes(needle);
                    box.hidden = !match;
                    if (needle && match) matching++;
                }
                group.hidden = needle ? [...group.children].every(child => child.hidden) : key !== tab;
            }
            tabs.hidden = Boolean(needle);
            searchCount.textContent = needle ? (matching ? matching + ' 项' : '无匹配') : '';
            query.parentElement.querySelector('button').hidden = !needle;
        }

        function makeSection(group, heading, extraClass = '') {
            const box = make('section', '', { className: 'mcf-section ' + extraClass });
            if (heading) box.append(make('h3', heading));
            groups.get(group).append(box);
            return box;
        }

        function switchRow(box, field, caption) {
            const input = make('input', '', { type: 'checkbox', checked: state()[field], id: 'mcf-option-' + field });
            const row = make('label', '', { className: 'mcf-switch' });
            row.append(input, make('span', caption));
            input.onchange = () => setOptions({ [field]: input.checked });
            box.append(row);
        }

        function createPanel() {
            panel = uiNode('aside', 'mcf-panel');
            panel.setAttribute('role', 'dialog');
            panel.setAttribute('aria-labelledby', 'mcf-panel-title');
            panel.tabIndex = -1;
            const heading = make('header', '', { className: 'mcf-header' });
            heading.append(make('h2', '🛡 ' + title, { id: 'mcf-panel-title' }),
                make('small', 'v0.4.2 · ' + api.pageType()), control('✕', closePanel, 'mcf-icon'));
            heading.lastChild.setAttribute('aria-label', '关闭设置面板');
            tabs = make('nav', '', { className: 'mcf-tabs' });
            tabs.setAttribute('aria-label', '设置分类');
            const finder = make('div', '', { className: 'mcf-finder' });
            query = make('input', '', { type: 'search', placeholder: '搜索设置项…' });
            searchCount = make('span');
            finder.append(query, control('✕', () => { query.value = ''; applySearch(); query.focus(); }), searchCount);
            query.oninput = applySearch;
            panel.append(heading, tabs, finder);
            groups = new Map();
            for (const [key, label] of sections) {
                const group = make('div', '', { className: 'mcf-group' });
                group.dataset.section = key;
                const toggle = control(label, () => {
                    tab = key;
                    for (const item of tabs.children) item.setAttribute('aria-pressed', String(item === toggle));
                    applySearch();
                    panel.scrollTop = 0;
                });
                toggle.setAttribute('aria-pressed', String(key === tab));
                tabs.append(toggle);
                groups.set(key, group);
                panel.append(group);
            }
            const base = makeSection('base', '基础设置');
            switchRow(base, 'enabled', '启用拦截');
            switchRow(base, 'reviewMode', '审查模式（标记命中并提供就地放行）');
            switchRow(base, 'rightClickBlock', 'Shift + 右键打开屏蔽菜单');
            switchRow(base, 'cardHoverBtn', '悬停卡片显示快捷屏蔽按钮');
            switchRow(base, 'lockBadgePosition', '将悬浮按钮锁定在右下角');
            base.append(make('p', '所有规则和开关即时生效。', { className: 'mcf-hint' }));
            switchRow(makeSection('base', '通知提示'), 'showNotifications', '显示页面通知');
            for (const field of projects) renderField('black', field);
            switchRow(makeSection('advanced', '精确过滤'), 'resolveAuthors', '按需读取卡片所对应条目页的作者信息');
            const comment = makeSection('comments', '评论区过滤');
            switchRow(comment, 'commentEnabled', '启用评论区过滤');
            comment.append(make('p', '主评论命中时隐藏整楼。楼中楼命中时，能识别的后续回复也会隐藏。可在「基础」开启审查模式查看原因。',
                { className: 'mcf-hint' }));
            for (const field of comments) renderField('comments', field);
            for (const base of [...projects, ...comments]) renderField('allow', api.allowField(base), base);
            renderTools();
            panel.addEventListener('keydown', event => {
                if (event.target.matches('input,textarea,select')) event.stopPropagation();
            });
            document.body.append(panel);
            applySearch();
        }

        function renderField(group, field, base = field) {
            const isId = Object.hasOwn(api.idFields, base);
            const box = makeSection(group, '', group === 'allow' ? 'mcf-allow' : '');
            box.dataset.search = api.fields[field];
            const drop = make('details', '', { className: 'mcf-field', open: true });
            const count = make('span', '', { className: 'mcf-count' });
            const label = make('summary', api.fields[field]);
            label.append(' ', count);
            const add = make('form', '', { className: 'mcf-add-rule' });
            const value = make('input', '', {
                type: 'text', placeholder: isId ? '输入 ID / UID 或粘贴页面链接' : '输入关键词或 /正则/i',
            });
            value.setAttribute('aria-label', api.fields[field]);
            const submit = make('button', '添加', { type: 'submit', className: 'mcf-primary' });
            const help = make('p', isId
                ? '可粘贴多个编号或链接，用空格、逗号或换行分隔。'
                : '普通词按包含匹配，忽略大小写和全半角。以 /…/ 包裹表示正则。普通词可用逗号或换行分隔。',
            { className: 'mcf-hint', hidden: true });
            const helpButton = control('?', () => { help.hidden = !help.hidden; });
            helpButton.setAttribute('aria-label', '规则语法速查');
            add.append(value, submit, helpButton);
            const search = make('input', '', { type: 'search', placeholder: '搜索本列表（支持 /正则/）', className: 'mcf-field-search' });
            const toolbar = make('div', '', { className: 'mcf-tools-row' });
            const chips = make('div', '', { className: 'mcf-rules' });
            const selected = new Set();
            let managing = false;

            function submitText(text) {
                try {
                    const entries = api.splitField(field, text, true);
                    if (!entries.length) return;
                    if (!isId) entries.forEach(api.wordRule);
                    const added = addRules(field, entries);
                    if (added.length) {
                        value.value = search.value = '';
                        selected.clear();
                    }
                    refresh();
                    toast(added.length ? '已添加 ' + added.length + ' 条规则' : '名单中已有这些规则');
                } catch (error) {
                    toast(error.message, null, true);
                }
            }

            add.onsubmit = event => { event.preventDefault(); submitText(value.value); };
            value.addEventListener('paste', event => {
                const pasted = event.clipboardData?.getData('text');
                if (!pasted || !/[\r\n]/.test(pasted)) return;
                event.preventDefault();
                submitText(pasted);
            });
            search.oninput = () => { selected.clear(); refresh(); };

            function remove(values) {
                const removed = removeRules(field, values);
                selected.clear();
                refresh();
                if (removed.length) toast('已删除 ' + removed.length + ' 条规则', () => restoreRules(field, removed));
            }

            function refresh() {
                const all = api.current().lists[field];
                const term = search.value.trim();
                let test;
                if (term) {
                    try { test = api.wordRule(term).test; }
                    catch { test = item => item.toLowerCase().includes(term.toLowerCase()); }
                }
                const visible = test ? all.filter(test) : all;
                for (const item of selected) if (!all.includes(item)) selected.delete(item);
                count.textContent = term ? visible.length + '/' + all.length : String(all.length);
                search.hidden = all.length <= 8 && !term;
                toolbar.replaceChildren();
                chips.replaceChildren();
                if (all.length && !managing) {
                    toolbar.append(control('批量管理', () => { managing = true; refresh(); }));
                } else if (all.length) {
                    toolbar.append(
                        control(term ? '全选匹配' : '全选', () => { visible.forEach(item => selected.add(item)); refresh(); }),
                        control('反选', () => { visible.forEach(item => { if (!selected.delete(item)) selected.add(item); }); refresh(); }),
                        control('删除所选(' + selected.size + ')', () => remove([...selected])),
                        control(term ? '删除匹配' : '清空', async () => {
                            if (!visible.length) return;
                            const ok = await ask({ heading: '删除规则', message: '删除当前范围内的 ' + visible.length + ' 条规则？',
                                submit: '删除', danger: true });
                            if (ok) remove(visible);
                        }),
                        control('完成', () => { managing = false; selected.clear(); refresh(); }),
                    );
                }
                const disabled = new Set(state().disabled[field]);
                for (const item of visible.slice(0, 300)) {
                    const chip = make('span', '', { className: 'mcf-rule' });
                    chip.classList.toggle('is-disabled', disabled.has(item));
                    const text = make('span', item, { title: item });
                    chip.append(text);
                    if (managing) {
                        const check = make('input', '', { type: 'checkbox', checked: selected.has(item) });
                        check.setAttribute('aria-label', item);
                        check.onchange = () => {
                            if (check.checked) selected.add(item);
                            else selected.delete(item);
                            const deleteButton = toolbar.children[2];
                            deleteButton.textContent = '删除所选(' + selected.size + ')';
                        };
                        chip.prepend(check);
                    } else {
                        const toggle = control(disabled.has(item) ? '▶' : '⏸', () => {
                            try { changeDisabled(field, item); refresh(); }
                            catch (error) { toast(error.message, null, true); }
                        }, 'mcf-rule-toggle');
                        toggle.title = disabled.has(item) ? '启用这条规则' : '停用这条规则';
                        const removeButton = control('✕', () => remove([item]));
                        removeButton.title = '删除规则';
                        chip.append(toggle, removeButton);
                    }
                    chips.append(chip);
                }
                if (!visible.length) chips.append(make('span', all.length ? '没有匹配的规则' : '暂无规则', { className: 'mcf-hint' }));
                if (visible.length > 300) chips.append(make('span', '还有 ' + (visible.length - 300) + ' 条。可用搜索定位。',
                    { className: 'mcf-hint' }));
            }

            drop.append(label, add, help, search, toolbar, chips);
            box.append(drop);
            lists.set(field, refresh);
            refresh();
        }

        function redrawLists() {
            if (!panel) return;
            for (const refresh of lists.values()) refresh();
            for (const input of panel.querySelectorAll('input[id^="mcf-option-"]')) {
                input.checked = state()[input.id.slice('mcf-option-'.length)];
            }
            applySearch();
        }

        function renderTester() {
            const box = makeSection('tools', '🧪 正则测试器');
            const pattern = make('input', '', { type: 'text', placeholder: '输入正则或普通词' });
            const sample = make('input', '', { type: 'text', placeholder: '粘贴样例文本' });
            const result = make('p', '', { className: 'mcf-hint' });
            const run = () => {
                const source = pattern.value.trim();
                if (!source) { result.textContent = '输入规则与样例文本即可测试。'; return; }
                try { result.textContent = api.wordRule(source).test(sample.value) ? '✅ 命中' : '未命中'; }
                catch (error) { result.textContent = error.message; }
            };
            pattern.oninput = sample.oninput = run;
            run();
            box.append(pattern, sample, result);
        }

        function renderImport() {
            const box = makeSection('tools', '规则配置导入 / 导出');
            const file = make('input', '', { type: 'file', accept: 'application/json,.json', hidden: true });
            file.onchange = async () => {
                try {
                    const selected = file.files?.[0];
                    if (!selected) return;
                    const parsed = JSON.parse(await selected.text());
                    const incoming = parsed?.config ?? parsed;
                    if (!incoming || !Object.keys(api.fields).some(field => Object.hasOwn(incoming, field))) {
                        throw new Error('找不到 MC 百科规则字段');
                    }
                    const checked = api.parseSettings(incoming);
                    const union = {};
                    const disabled = { ...state().disabled };
                    for (const field of Object.keys(api.fields)) {
                        const local = api.current().lists[field];
                        union[field] = [...new Set([...local, ...checked.lists[field]])];
                        disabled[field] = [...disabled[field], ...checked.raw.disabled[field].filter(value => !local.includes(value))];
                    }
                    const patch = { disabled };
                    for (const field of Object.keys(api.defaults)) {
                        if (field !== 'lockBadgePosition' && Object.hasOwn(incoming, field)) patch[field] = checked.raw[field];
                    }
                    setLists(union, patch);
                    redrawLists();
                    toast('已导入并合并规则配置');
                } catch (error) {
                    toast('导入失败：' + error.message, null, true);
                } finally {
                    file.value = '';
                }
            };
            const exportFile = () => {
                const { lockBadgePosition, ...config } = state();
                const fileUrl = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' }));
                const link = make('a', '', { href: fileUrl, download: 'mcmod-filter-rules.json' });
                link.click();
                setTimeout(() => URL.revokeObjectURL(fileUrl), 2000);
                toast('已导出规则配置文件');
            };
            const row = make('div', '', { className: 'mcf-tools-row' });
            row.append(control('⬇ 导出为文件', exportFile, 'mcf-primary'), control('⬆ 从文件导入', () => file.click()));
            box.append(row, file, make('p', '导入时合并名单，文件中的开关设置即时生效。', { className: 'mcf-hint' }));
        }

        function renderBatch() {
            const box = makeSection('tools', '⛔ 批量屏蔽');
            const field = make('select');
            field.setAttribute('aria-label', '规则类型');
            for (const [value, label] of Object.entries(api.idFields)) field.append(make('option', label, { value }));
            const input = make('textarea', '', { rows: 3, placeholder: '粘贴 ID、UID 或页面链接' });
            input.setAttribute('aria-label', '批量输入');
            const submit = control('批量屏蔽', async () => {
                try {
                    const key = field.value;
                    const candidates = [...new Set(api.splitField(key, input.value))].filter(value => !api.current().lists[key].includes(value));
                    if (!candidates.length) { toast('没有新的规则可添加'); return; }
                    const ok = await ask({ heading: '批量屏蔽确认', message: '将 ' + candidates.length + ' 条规则加入黑名单？',
                        submit: '屏蔽', danger: true });
                    if (!ok) return;
                    const added = addRules(key, candidates);
                    input.value = '';
                    redrawLists();
                    toast('已添加 ' + added.length + ' 条规则', () => { removeRules(key, added); redrawLists(); });
                } catch (error) {
                    toast(error.message, null, true);
                }
            }, 'mcf-primary');
            box.append(field, input, submit);
        }

        function renderReports() {
            const health = makeSection('tools', '🩺 运行自检');
            const result = make('p', '', { className: 'mcf-hint' });
            const report = () => {
                const cards = [...api.pageCards()].filter(card => api.readCard(card)).length;
                const replies = document.querySelectorAll('.common-comment-block :is(.comment-row,.comment-reply-row)').length;
                result.textContent = api.pageType() + ' · 识别 ' + cards + ' 个条目和 ' + replies + ' 条评论 · '
                    + (state().enabled ? '拦截已启用' : '拦截已暂停');
            };
            health.append(control('运行自检', report), result);
            report();
            const rules = makeSection('tools', '📋 规则体检');
            const notes = make('div', '', { className: 'mcf-hint' });
            rules.append(control('检查规则', () => {
                const tally = new Map();
                for (const hit of api.hits()) {
                    const rule = api.ruleFromReason(hit.reason);
                    if (!rule) continue;
                    const key = JSON.stringify(rule);
                    tally.set(key, 1 + (tally.get(key) || 0));
                }
                const unused = [];
                const broad = [];
                for (const [field, label] of Object.entries(api.blockFields)) {
                    for (const value of api.current().lists[field]) {
                        if (state().disabled[field].includes(value)) continue;
                        const n = tally.get(JSON.stringify([field, value])) || 0;
                        if (!n) unused.push(label + ' · ' + value);
                        if (n >= 10 || (!Object.hasOwn(api.idFields, field) && [...value].length === 1)) broad.push(label + ' · ' + value);
                    }
                }
                notes.replaceChildren(make('p', '可能过宽 ' + broad.length + ' 条'),
                    ...broad.slice(0, 20).map(value => make('div', value)),
                    make('p', '本次会话未命中 ' + unused.length + ' 条'),
                    ...unused.slice(0, 20).map(value => make('div', value)));
            }), notes);
        }

        function renderLog() {
            const box = makeSection('tools', '🔎 屏蔽记录');
            const title = make('p', '', { className: 'mcf-hint' });
            const summary = make('p', '', { className: 'mcf-hint' });
            const items = make('div', '', { className: 'mcf-log' });
            const toggle = control('展开 / 收起', () => { logOpen = !logOpen; refreshLog(); });
            box.append(title, toggle, summary, items);
            let renderedSignature;
            refreshLog = () => {
                const hits = api.hits();
                title.textContent = '本次会话共 ' + api.sessionHits() + ' 条 · 累计拦截 ' + api.totalHits() + ' 次';
                const byField = new Map();
                for (const hit of hits) {
                    const name = api.fields[api.ruleFromReason(hit.reason)?.[0]] || hit.reason;
                    byField.set(name, (byField.get(name) || 0) + 1);
                }
                summary.textContent = '分类：' + ([...byField].map(([key, n]) => key + ' × ' + n).join('、') || '暂无');
                toggle.setAttribute('aria-expanded', String(logOpen));
                items.hidden = !logOpen;
                if (!logOpen) return;
                const signature = JSON.stringify(hits.slice(0, 100).map(hit => {
                    const rule = api.ruleFromReason(hit.reason);
                    return [hit.reason, hit.info.label, hit.info.url, rule && api.current().lists[rule[0]].includes(rule[1])];
                }));
                if (renderedSignature === signature) return;
                renderedSignature = signature;
                items.replaceChildren();
                if (!hits.length) items.append(make('p', '暂无记录', { className: 'mcf-hint' }));
                for (const hit of hits.slice(0, 100)) {
                    const row = make('div', '', { className: 'mcf-hit' });
                    const info = hit.info;
                    const title = info.label || '条目';
                    const label = info.url ? make('a', title, { href: info.url, target: '_blank', rel: 'noopener noreferrer' }) : make('span', title);
                    label.title = title;
                    row.append(make('small', hit.reason, { title: hit.reason }), label);
                    const actions = make('div', '', { className: 'mcf-tools-row' });
                    if (hit.pass || hit.release) actions.append(control('✅放行', () => {
                        if (hit.release) hit.release();
                        else allow(hit.pass, title);
                    }, 'mcf-log-pass'));
                    const pair = api.ruleFromReason(hit.reason);
                    if (pair && api.current().lists[pair[0]].includes(pair[1])) {
                        actions.append(control('✂删规则', async () => {
                            const ok = await ask({ heading: '删除规则', message: '删除规则「' + pair[1] + '」？',
                                danger: true, submit: '删除' });
                            if (!ok) return;
                            const removed = removeRules(pair[0], [pair[1]]);
                            redrawLists();
                            toast('已删除规则：' + pair[1], () => restoreRules(pair[0], removed));
                        }));
                    }
                    row.append(actions);
                    items.append(row);
                }
            };
            refreshLog();
        }

        function renderTools() {
            renderTester();
            renderImport();
            renderBatch();
            const reset = makeSection('tools', '重置');
            const actions = make('div', '', { className: 'mcf-tools-row' });
            actions.append(control('切换本页临时放行', api.toggleReveal), control('恢复默认设置', async () => {
                const ok = await ask({ heading: '重置设置', message: '恢复默认设置并清空所有黑白名单？',
                    danger: true, submit: '重置' });
                if (ok) {
                    api.commit({ ...api.defaults });
                    redrawLists();
                    toast('已恢复默认设置');
                }
            }));
            reset.append(actions);
            renderReports();
            renderLog();
        }

        function sync() {
            const raw = state();
            badge.classList.toggle('is-paused', !raw.enabled);
            badge.classList.toggle('is-locked', raw.lockBadgePosition);
            badge.title = raw.lockBadgePosition ? '打开设置 · 角标已锁定' : '打开设置 · 拖动可移动';
            const text = raw.enabled ? '🛡 已拦截 ' + api.sessionHits() + '（共' + api.totalHits() + '）' : '🛡 已暂停';
            if (badge.textContent !== text) badge.textContent = text;
            if (!drag) positionBadge(badgePosition);
            if (!raw.enabled || !raw.cardHoverBtn || hoverTarget?.target.dataset.mcfFiltered) hideHover();
            if (panel?.classList.contains('is-open')) refreshLog?.();
        }

        document.addEventListener('contextmenu', rightClick, true);
        document.addEventListener('mouseover', updateHover, true);
        document.addEventListener('scroll', event => {
            if (!menu?.contains(event.target)) closeMenu();
            hideHover();
        }, true);
        document.addEventListener('pointerdown', event => {
            if (!menu?.contains(event.target)) closeMenu();
        }, true);
        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || currentDialog?.open) return;
            if (menu) closeMenu();
            else closePanel();
        }, true);
        GM_registerMenuCommand('打开设置面板', openPanel);
        GM_registerMenuCommand('暂停/启用拦截', () => { setOptions({ enabled: !state().enabled }); redrawLists(); });
        GM_registerMenuCommand('切换本页临时放行', api.toggleReveal);
        setTimeout(() => {
            if (state().enabled && api.sessionHits()) toast('🛡 本次加载已拦截 ' + api.sessionHits() + ' 个条目');
        }, 3500);
        return {
            allow, sync,
            remoteSync() {
                if (!panel?.contains(document.activeElement) || !document.activeElement.matches('input,textarea,select')) redrawLists();
                toast('已同步另一个标签页的配置');
            },
        };
    }

    const storageKey = 'mcmod-filter-rules-v1';
    const mainHost = 'www.mcmod.cn';
    const home = [mainHost, 'mcmod.cn'].includes(location.hostname) &&
        /^\/(?:v2(?:\/index\.html|\/)?|index\.(?:html|php))?$/.test(location.pathname);
    const categories = {
        mod: '模组',
        pack: '整合包',
        author: '作者',
        user: '评论区用户',
        comment: '评论正文',
    };
    const idFields = {
        modIds: '模组 ID',
        packIds: '整合包 ID',
        authorIds: '作者词条 ID',
        authorUids: '作者账号 UID',
        userUids: '评论用户 UID',
    };
    const keywordFields = {
        modWords: '模组名称',
        packWords: '整合包名称',
        authorWords: '作者名称或别名',
        userWords: '评论用户名',
        commentWords: '评论正文',
    };
    const blockFields = { ...idFields, ...keywordFields };
    const allowField = field => 'allow' + field[0].toUpperCase() + field.slice(1);
    const allowBase = Object.fromEntries(Object.keys(blockFields).map(field => [allowField(field), field]));
    const fields = { ...blockFields, ...Object.fromEntries(
        Object.entries(allowBase).map(([field, base]) => [field, blockFields[base]]),
    ) };
    const defaults = {
        enabled: true, reviewMode: false, rightClickBlock: true,
        cardHoverBtn: false, lockBadgePosition: false, showNotifications: true,
        commentEnabled: true, resolveAuthors: true,
    };
    const cardSelectors = [
        '.modlist-block', '.result-item', '.author-mods .block', '.author-partner .block',
        '.class-relation-list li.relation > ul > li',
        '.class_category_block .left .list :is(.block,.card)',
        '.class_category_block :is(.left,.right) .list > li',
    ];
    if (home) {
        cardSelectors.push(
            '[id^="indexNew_"] > .block', '.az_block .list > li', '.list_block .farme > li',
            '.chart_block .list > li', '.card_block .list li', '.postText .mainMod',
            '.news_block .editor ul > li', '.ClassShowBox a.item', '.block_hot li.item', '.news > a.block',
        );
    }
    const cardSelector = cardSelectors.join(',');
    const entryLinkSelector = 'a[href*="class/"], a[href*="modpack/"], a[href*="author/"]';
    const entryWrapperSelector = 'li,article,tr,[role="listitem"],.card,.block,.item,.list-block';
    const excludedEntryArea = 'header,footer,nav,[role="navigation"],.breadcrumb,.common-header,' +
        '.common-comment-block,.common-text,.postContent,[data-mcf-ui]';
    const entryWalkBoundary = 'body,main,nav,header,footer,[role="main"],[role="navigation"]';
    const detail = entry(location.href);
    const observed = new Map();
    const visible = new WeakSet();
    const revealed = new WeakSet();
    const manual = new WeakSet();
    const hits = new Map();
    const seenNodes = new WeakMap();
    const seenReplies = new WeakMap();
    const authorCache = new Map();
    const authorPending = new Map();
    const countKey = 'mcmod-filter-hits-v1';
    let sessionHits = 0;
    let nodeSequence = 0;
    let hasManual = false;
    let totalHits = Number(GM_getValue(countKey, 0)) || 0;
    let authorRequests = 0;
    let marked = new Map();
    let frame = 0;
    let revealPage = false;
    let detailNotice;
    let ui;
    let settings = parseSettings(GM_getValue(storageKey, {}), true);

    function positiveId(value) {
        return /^\d+$/.test(value ?? '') ? String(value).replace(/^0+/, '') : '';
    }

    function linkUrl(href, base = location.href) {
        if (!href) return null;
        try {
            const url = new URL(href, base);
            return ['http:', 'https:'].includes(url.protocol) ? url : null;
        } catch {
            return null;
        }
    }

    function entry(href, base) {
        const url = linkUrl(href, base);
        if (![mainHost, 'mcmod.cn'].includes(url?.hostname)) return null;
        const match = /^\/(class|modpack|author)\/(\d+)\.html$/.exec(url.pathname);
        if (!match || !positiveId(match[2])) return null;
        const type = { class: 'mod', modpack: 'pack', author: 'author' }[match[1]];
        return { type, id: positiveId(match[2]), url: `https://${mainHost}${url.pathname}` };
    }

    function uidFromLink(href) {
        const url = linkUrl(href);
        return url?.hostname === 'center.mcmod.cn'
            ? positiveId(/^\/(\d+)\/?$/.exec(url.pathname)?.[1])
            : '';
    }

    function uidFromAvatar(scope) {
        // MC 百科的本地用户头像路径同时包含账号 UID 和以 UID 开头的文件名。
        const url = linkUrl(scope.querySelector('img')?.getAttribute('src'));
        if (url?.hostname !== 'i.mcmod.cn') return '';
        return positiveId(/^\/user\/avatar\/\d+\/(\d+)\/\1_/.exec(url.pathname)?.[1]);
    }

    function identity(scope) {
        const link = [...scope.querySelectorAll('a[href]')].find(a => uidFromLink(a.href));
        return uidFromLink(link?.href) ||
            positiveId(scope.querySelector('[data-uid]')?.getAttribute('data-uid')) ||
            uidFromAvatar(scope);
    }

    function normalize(value) {
        return value.replace(/\s+/g, ' ').trim().normalize('NFKC');
    }

    function safePattern(pattern) {
        if (pattern.length > 350) return false;
        const sequence = pattern.replace(/\\[\s\S]|\[(?:\\[\s\S]|[^\\\]])*\]/g, '_')
            .replace(/\(\?(?:[:=!]|<[=!]|<[^>]+>)/g, '(');
        const stack = [{ repeated: false, alternatives: false }];
        let repeats = 0;
        for (let offset = 0; offset < sequence.length; offset++) {
            const token = sequence[offset];
            const group = stack.at(-1);
            if (token === '(') {
                stack.push({ repeated: false, alternatives: false });
            } else if (token === '|' && stack.length > 1) {
                group.alternatives = true;
            } else if (token === ')' && stack.length > 1) {
                const closed = stack.pop();
                const parent = stack.at(-1);
                const suffix = sequence.slice(offset + 1);
                if ((closed.repeated || closed.alternatives) && /^(?:[+*]|\{\d+,\d*\})/.test(suffix)) return false;
                parent.repeated ||= closed.repeated;
            } else if (token === '+' || token === '*' || /^\{\d+,\d*\}/.test(sequence.slice(offset))) {
                group.repeated = true;
                if (++repeats > 14) return false;
            }
        }
        return true;
    }

    function wordRule(source) {
        if (source.startsWith('/')) {
            const end = source.lastIndexOf('/');
            const flags = source.slice(end + 1);
            if (end <= 1 || !/^[imsu]*$/.test(flags)) throw new Error('正则格式应为 /表达式/imsu');
            const body = source.slice(1, end);
            if (!safePattern(body)) throw new Error('正则过长，或含有可能造成大量回溯的重复组合');
            const expression = new RegExp(body, flags.includes('i') ? flags : flags + 'i');
            return { source, test: value => expression.test(value) };
        }
        const needle = normalize(source).toLowerCase();
        return { source, test: value => normalize(value).toLowerCase().includes(needle) };
    }

    function splitField(field, text, forInput = false) {
        const base = allowBase[field] ?? field;
        if (Object.hasOwn(idFields, base)) {
            return text.split(/[\s,，、]+/).filter(Boolean).map((value) => {
                const type = { modIds: 'mod', packIds: 'pack', authorIds: 'author' }[base];
                const item = type ? entry(value) : null;
                const id = positiveId(value) || (type ? (item?.type === type ? item.id : '') : uidFromLink(value));
                if (!id) throw new Error(`${fields[field]}格式无效：${value}`);
                return id;
            });
        }
        return text.split(/\r?\n/).flatMap(line => forInput && !line.trim().startsWith('/')
            ? line.split(/[,，]/) : [line]).map(line => line.trim()).filter(Boolean);
    }

    function parseSettings(data, acceptOldRegex = false) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('规则必须为 JSON 对象');
        const raw = { ...defaults };
        for (const option of Object.keys(defaults)) {
            if (!Object.hasOwn(data, option)) continue;
            if (typeof data[option] !== 'boolean') throw new Error(`开关格式无效：${option}`);
            raw[option] = data[option];
        }
        raw.disabled = {};
        const ids = {};
        const words = {};
        const lists = {};
        for (const [field, label] of Object.entries(fields)) {
            if (Object.hasOwn(data, field) && typeof data[field] !== 'string') {
                throw new Error(`${label}必须是文本`);
            }
            const values = [...new Set(splitField(field, data[field] ?? ''))];
            lists[field] = values;
            raw[field] = values.join('\n');
            const disabled = Array.isArray(data.disabled?.[field]) ? data.disabled[field] : [];
            const disabledSet = new Set(disabled);
            raw.disabled[field] = values.filter(value => disabledSet.has(value));
            const active = values.filter(value => !disabledSet.has(value));
            if (Object.hasOwn(idFields, allowBase[field] ?? field)) {
                ids[field] = new Set(active);
                continue;
            }
            words[field] = [];
            for (const line of active) {
                try {
                    words[field].push(wordRule(line));
                } catch (error) {
                    if (acceptOldRegex) {
                        raw.disabled[field].push(line);
                        continue;
                    }
                    throw new Error(`${label}规则 ${line}：${error.message}`);
                }
            }
        }
        const hasAuthorRules = Boolean(ids.authorIds.size || ids.authorUids.size || words.authorWords.length);
        return {
            raw, ids, words, lists, hasAuthorRules,
            hasAuthorAllowRules: Boolean(ids.allowAuthorIds.size || ids.allowAuthorUids.size ||
                words.allowAuthorWords.length),
            hasProjectRules: Boolean(hasAuthorRules || ids.modIds.size || ids.packIds.size ||
                words.modWords.length || words.packWords.length),
            hasCommentRules: Boolean(raw.commentEnabled && (ids.userUids.size ||
                words.userWords.length || words.commentWords.length)),
        };
    }

    function idMatch(field, id) {
        return id && settings.ids[field].has(id) ? `${fields[field]} ${id}` : '';
    }

    function wordMatch(field, values) {
        const rule = settings.words[field].find(({ test }) => values.some(value => value && test(value)));
        return rule ? `${fields[field]} ${rule.source}` : '';
    }

    function authorMatch(author) {
        return idMatch('authorIds', author.id) || idMatch('authorUids', author.uid) ||
            wordMatch('authorWords', author.names);
    }

    function authorAllowed(author) {
        return idMatch('allowAuthorIds', author.id) || idMatch('allowAuthorUids', author.uid) ||
            wordMatch('allowAuthorWords', author.names);
    }

    const projectAuthorSelector = '.author .frame > ul > li';

    function projectAuthor(row) {
        const name = row.querySelector('.member .name');
        const avatar = row.querySelector('.avatar');
        const link = name?.querySelector('a[href]') ?? avatar?.querySelector('a[href]');
        const display = name?.textContent.trim();
        const title = name?.title || avatar?.title || '';
        const aliases = title.startsWith(`${display} - `) ? title.slice(display.length + 3).split(' / ') : [];
        return {
            id: entry(link?.getAttribute('href'), `https://${mainHost}/`)?.id,
            uid: identity(row),
            names: [display, title, ...aliases],
        };
    }

    function projectAuthors(root) {
        return [...root.querySelectorAll(projectAuthorSelector)].map(projectAuthor);
    }

    function firstAuthorMatch(authors) {
        if (authors?.some(authorAllowed)) return '';
        for (const author of authors ?? []) {
            const reason = authorMatch(author);
            if (reason) return reason;
        }
        return '';
    }

    function loadAuthors(item) {
        if (authorPending.has(item.url)) return authorPending.get(item.url);
        if (authorCache.has(item.url)) return Promise.resolve(authorCache.get(item.url));
        if (authorRequests >= 3) {
            return Promise.race(authorPending.values()).then(() => loadAuthors(item));
        }
        let resolve;
        const pending = new Promise(done => { resolve = done; });
        authorPending.set(item.url, pending);
        authorRequests++;
        const finish = (authors) => {
            authorPending.delete(item.url);
            authorCache.set(item.url, authors);
            authorRequests--;
            queueScan();
            resolve(authors);
        };
        GM_xmlhttpRequest({
            method: 'GET', url: item.url, anonymous: true, timeout: 8000,
            onload(response) {
                if (response.status !== 200 || (response.finalUrl && entry(response.finalUrl)?.url !== item.url)) {
                    finish([]);
                    return;
                }
                const template = document.createElement('template');
                template.innerHTML = response.responseText;
                if (item.type === 'author') {
                    const profile = template.content.querySelector('.author-user-frame');
                    finish(profile ? [{ id: item.id, uid: identity(profile), names: [] }] : []);
                } else {
                    finish(projectAuthors(template.content));
                }
            },
            onerror: () => finish([]),
            ontimeout: () => finish([]),
            onabort: () => finish([]),
        });
        return pending;
    }

    function itemNames(links) {
        return links.flatMap(link => [
            link.getAttribute('title'),
            (link.querySelector('.name') ?? link).textContent.trim(),
            link.querySelector('img')?.alt,
        ]);
    }

    const visibilityObserver = typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
            for (const { target, isIntersecting } of entries) {
                if (isIntersecting) visible.add(target);
                else visible.delete(target);
            }
            queueScan();
        }, { rootMargin: '250px 0px' })
        : null;

    function cachedAuthors(item, card) {
        if (!settings.raw.resolveAuthors) return [];
        if (!authorCache.has(item.url) && !authorPending.has(item.url)) {
            if (authorRequests < 3 && (!visibilityObserver || visible.has(card))) loadAuthors(item);
            if (visibilityObserver && !observed.has(card)) {
                observed.set(card, item.url);
                visibilityObserver.observe(card);
            }
        }
        return authorCache.get(item.url) ?? null;
    }

    function matchItem(item, names, card, allowLoad = true) {
        if (item.type === 'author') {
            const profile = card.matches('.author-user-frame') ? card : card.querySelector('.avatar, .head');
            const uid = profile ? identity(profile) : '';
            const author = { id: item.id, uid, names };
            if (authorAllowed(author)) return '';
            const reason = authorMatch(author);
            if (uid || !allowLoad || (!settings.ids.authorUids.size &&
                !(reason && settings.ids.allowAuthorUids.size))) return reason;
            const authors = cachedAuthors(item, card);
            if (authors?.some(authorAllowed) || (!authors && settings.ids.allowAuthorUids.size)) return '';
            return reason || firstAuthorMatch(authors);
        }
        if (entryAllowed(item, names)) return '';
        const reason = idMatch(`${item.type}Ids`, item.id) || wordMatch(`${item.type}Words`, names);
        if (reason ? !settings.hasAuthorAllowRules : !settings.hasAuthorRules) return reason;
        const inline = projectAuthors(card);
        const authors = inline.length || !allowLoad ? inline : cachedAuthors(item, card);
        if (authors?.some(authorAllowed) || (!authors && settings.hasAuthorAllowRules)) return '';
        return reason || firstAuthorMatch(authors);
    }

    function entryAllowed(item, names) {
        return idMatch(allowField(`${item.type}Ids`), item.id) ||
            wordMatch(allowField(`${item.type}Words`), names);
    }

    function readCard(card) {
        const selector = card.matches('.result-item') ? '.head > a[href]' :
            card.matches('.modlist-block') ? '.title a[href], .cover a[href]' : 'a[href]';
        const links = card.matches('a[href]') ? [card] : [...card.querySelectorAll(selector)];
        const item = links.map(link => entry(link.href)).find(Boolean);
        if (!item) return null;
        const names = itemNames(links.filter(link => entry(link.href)?.url === item.url));
        const label = card.querySelector('.head, .title, .name')?.textContent.trim() ||
            names.find(Boolean) || item.id;
        return { ...item, names, label };
    }

    function itemLinks(node) {
        return [...node.querySelectorAll(entryLinkSelector)].map(link => entry(link.href)).filter(Boolean);
    }

    function hasPeerCard(node, item) {
        return [node.previousElementSibling, node.nextElementSibling].some(peer => {
            if (!peer || peer.tagName !== node.tagName) return false;
            if (node.classList.length && ![...node.classList].some(name => peer.classList.contains(name))) return false;
            const entries = itemLinks(peer);
            return entries.length > 0 && entries[0].type === item.type && entries[0].url !== item.url &&
                entries.every(other => other.url === entries[0].url);
        });
    }

    function entryCard(link) {
        const item = entry(link.href);
        if (!item) return null;
        const known = link.closest(cardSelector);
        if (known && readCard(known)?.url === item.url) return known;
        if (link.closest(excludedEntryArea) || known?.matches('.result-item,.modlist-block')) return null;
        // Some older index layouts have anonymous ranked rows and tiles rather than the modern card classes.
        let parent = link.parentElement;
        for (let depth = 0; parent && depth < 5 && !parent.matches(entryWalkBoundary);
            depth++, parent = parent.parentElement) {
            if (parent.closest(excludedEntryArea)) break;
            if (itemLinks(parent).some(other => other.url !== item.url)) break;
            if (parent.matches(entryWrapperSelector) || hasPeerCard(parent, item)) return parent;
        }
        return link;
    }

    function cardAt(target) {
        const link = target.closest(entryLinkSelector);
        if (link) {
            const card = entryCard(link);
            if (card) return card;
        }
        const known = target.closest(cardSelector);
        if (known) return known;
        if (target.closest(excludedEntryArea)) return null;
        for (let wrapper = target, depth = 0;
            wrapper && depth < 5 && !wrapper.matches(entryWalkBoundary);
            wrapper = wrapper.parentElement, depth++) {
            const first = [...wrapper.querySelectorAll(entryLinkSelector)].find(anchor => entry(anchor.href));
            if (first && entryCard(first) === wrapper) return wrapper;
        }
        return null;
    }

    function pageCards() {
        const cards = new Set(document.querySelectorAll(cardSelector));
        for (const link of document.querySelectorAll(entryLinkSelector)) {
            const card = entryCard(link);
            if (card) cards.add(card);
        }
        return cards;
    }

    function replyMention(body) {
        const mention = body?.firstElementChild;
        const prefix = mention?.previousSibling;
        const suffix = mention?.nextSibling;
        const uid = uidFromLink(mention?.getAttribute('href'));
        if (uid && prefix === body.firstChild && /^(?:回复|回覆|回復|Reply to)\s*$/i.test(prefix?.textContent ?? '') &&
            /^\s*[:：]/.test(suffix?.textContent ?? '')) {
            return { uid, prefix, mention, suffix };
        }
        return null;
    }

    function plainText(element, isReply = false) {
        if (!element) return '';
        const copy = element.cloneNode(true);
        const target = isReply ? replyMention(copy) : null;
        if (target) {
            target.prefix.remove();
            target.mention.remove();
            target.suffix.textContent = target.suffix.textContent.replace(/^\s*[:：]/, '');
        }
        for (const node of copy.querySelectorAll('br, img, p, div, li')) {
            if (node.matches('br, img')) {
                node.replaceWith(document.createTextNode(node.alt || '\n'));
            } else {
                node.append('\n');
            }
        }
        return copy.textContent.trim();
    }

    function readComment(row) {
        const reply = row.matches('.comment-reply-row');
        const user = row.querySelector(reply ? '.comment-reply-row-username' : '.comment-row-username');
        const account = user?.querySelector('a[data-uid], a[href*="center.mcmod.cn"]:not(.common-user-lv)');
        const avatar = row.querySelector(reply ? '.comment-reply-row-avatar' : '.comment-row-userinfo .frame');
        const uid = positiveId(account?.dataset.uid) || uidFromLink(account?.href) || positiveId(avatar?.dataset.uid);
        const name = (account?.textContent || user?.textContent || '').trim();
        const body = row.querySelector(reply ? '.comment-reply-row-text-content' : '.comment-row-text-content');
        const owner = reply ? row : row.querySelector(':scope > .comment-row-content');
        const id = owner?.querySelector(':scope > .comment-tools .comment-id')?.value;
        return { uid, name, id, body, reply };
    }

    function commentMatch({ uid, name, body, reply, text }) {
        if (idMatch('allowUserUids', uid) || wordMatch('allowUserWords', [name])) return '';
        const content = text ?? ((settings.words.allowCommentWords.length || settings.words.commentWords.length)
            ? plainText(body, reply) : '');
        if (wordMatch('allowCommentWords', [content])) return '';
        return idMatch('userUids', uid) || wordMatch('userWords', [name]) || wordMatch('commentWords', [content]);
    }

    function matchActivity(row) {
        const topic = row.querySelector('.dec > a[href]');
        if (!topic) return '';
        const title = topic.textContent.trim();
        if (/^(?:评论了|評[論论]了|Commented on)/i.test(title)) {
            const profile = row.querySelector(':scope > a[href]');
            const name = profile?.title || profile?.querySelector('img')?.alt;
            const reason = settings.raw.commentEnabled ? commentMatch({
                uid: uidFromLink(profile?.href), name, body: row.querySelector('.dec > span'),
            }) : '';
            if (reason) return reason;
        }
        const item = entry(topic.href);
        return item ? matchItem(item, [topic.title || title], row) : '';
    }

    function make(tag, text, props = {}) {
        const node = document.createElement(tag);
        Object.assign(node, props);
        if (text) node.textContent = text;
        return node;
    }

    function button(text, action) {
        const el = make('button', text, { type: 'button' });
        el.addEventListener('click', action);
        return el;
    }

    function notice(text, action, buttonLabel = '展开') {
        const el = make('div');
        el.dataset.mcfUi = '';
        el.className = 'mcf-notice';
        el.append(make('span', text), button(buttonLabel, action));
        return el;
    }

    function detailInfo() {
        if (!detail) return;
        const target = document.querySelector('.common-center > .center');
        if (!target) return;
        const title = document.querySelector(detail.type === 'author' ? '.author-name' : '.class-title');
        const names = [...(title?.querySelectorAll('h3, h4, h5, .subname') ?? [])]
            .map(el => el.textContent.trim()).filter(Boolean);
        const label = names.join(' / ') || categories[detail.type];
        const scope = detail.type === 'author' ? document.querySelector('.author-user-frame') ?? target : target;
        const aliases = title?.querySelector('.subname')?.textContent.trim().split(' / ') ?? [];
        return { ...detail, target, scope, label, names: [...names, names.join(' '), ...aliases] };
    }

    function markDetail(next) {
        const info = detailInfo();
        if (!info) return;
        const { target, scope, label, names } = info;
        const reason = matchItem(info, names, scope, false);
        if (!reason || revealed.has(target)) return;
        next.set(target, { reason, label, mode: 'detail', info });
        if (settings.raw.reviewMode || (marked.get(target)?.reason === reason && detailNotice?.isConnected)) return;
        detailNotice?.remove();
        detailNotice = notice(`已屏蔽${categories[detail.type]}：${label}（${reason}）`, () => {
            revealed.add(target);
            scan();
        });
        target.before(detailNotice);
    }

    function markComment(next, row, comment, reason, inherited = false) {
        const { name, body, reply, text = plainText(body, reply) } = comment;
        const info = { ...comment, type: 'comment', label: [name, text].filter(Boolean).join(' · ') };
        next.set(row, { reason, label: name || '评论', mode: 'hide', info, commentRow: true, inherited });
    }

    function repliesInOrder(floor) {
        const current = [...floor.querySelectorAll('.comment-reply-row')].map(row => {
            const comment = readComment(row);
            comment.text = plainText(comment.body, true);
            return { row, comment, id: positiveId(comment.id), targetUid: replyMention(comment.body)?.uid };
        });
        if (current.some(item => !item.id)) return current;
        const seen = seenReplies.get(floor) ?? new Map();
        seenReplies.set(floor, seen);
        const byId = new Map(current.map(item => [item.id, item]));
        for (const { id, targetUid, comment } of current) {
            const { uid, name, text } = comment;
            seen.set(id, { id, targetUid, comment: { uid, name, text } });
        }
        while (seen.size > 500) seen.delete(seen.keys().next().value);
        return [...new Map([...seen, ...byId]).values()].sort((a, b) =>
            a.id.length - b.id.length || a.id.localeCompare(b.id));
    }

    function markReplyChain(next, floor) {
        const earlier = new Map();
        for (const { row, comment, targetUid } of repliesInOrder(floor)) {
            const parent = earlier.get(targetUid);
            // The site identifies the replied-to account, so mixed visible/blocked candidates are ambiguous.
            const inherited = parent && !parent.hasVisible ? parent.reason : '';
            const reason = inherited || commentMatch(comment);
            if (row && reason) {
                markComment(next, row, comment, inherited ? `回复链命中：${reason}` : reason, Boolean(inherited));
            }
            if (comment.uid) {
                const previous = earlier.get(comment.uid);
                earlier.set(comment.uid, { hasVisible: previous?.hasVisible || !reason, reason });
            }
        }
    }

    function markComments(next) {
        if (!settings.hasCommentRules) return;
        for (const row of document.querySelectorAll('.common-comment-block .comment-row')) {
            const comment = readComment(row);
            const reason = commentMatch(comment);
            const floor = commentSlot(row)?.querySelector(':scope > .comment-reply-floor');
            if (reason) {
                markComment(next, row, comment, reason);
                if (settings.raw.reviewMode && floor) {
                    for (const reply of floor.querySelectorAll('.comment-reply-row')) {
                        markComment(next, reply, readComment(reply), `主评论命中：${reason}`, true);
                    }
                }
            } else if (floor) {
                markReplyChain(next, floor);
            }
        }
    }

    function commentSlot(row) {
        return row.matches('.comment-reply-row') ? row : row.querySelector(':scope > .comment-row-content');
    }

    function renderComment(row, hit) {
        const root = commentSlot(row);
        if (!root) return;
        if (!settings.raw.reviewMode) {
            clearNotice(row);
            return;
        }
        row.classList.add('mcf-comment-review');
        const existing = root.querySelector(':scope > .mcf-comment-banner');
        if (existing?.dataset.reason === hit.reason) return;
        existing?.remove();
        const banner = make('div', '', { className: 'mcf-comment-banner' });
        banner.dataset.mcfUi = '';
        banner.dataset.reason = hit.reason;
        banner.append(make('span', `命中规则：${hit.reason}`));
        const pass = hit.inherited ? null : passFor(hit.info);
        if (pass) banner.append(button('放行', () => ui.allow(pass, hit.label)));
        root.prepend(banner);
    }

    function context(target) {
        if (!(target instanceof Element)) return null;
        if (target.closest('[data-mcf-ui]')) return null;
        const comment = target.closest('.common-comment-block :is(.comment-row,.comment-reply-row)');
        if (comment) {
            const info = readComment(comment);
            return { ...info, type: 'comment', label: info.name || '评论', target: comment };
        }
        const authorRow = target.closest(projectAuthorSelector);
        if (authorRow) {
            const info = projectAuthor(authorRow);
            return { ...info, type: 'author', label: info.names[0] || info.id, target: authorRow };
        }
        const card = cardAt(target);
        const info = card ? readCard(card) : null;
        if (info) return { ...info, target: card, card: true };
        const summary = target.closest('.class-title,.author-user-frame');
        return summary ? detailInfo() : null;
    }

    function passFor(info) {
        if (!info) return null;
        if (info.type === 'comment') {
            if (info.uid) return ['allowUserUids', info.uid];
            if (info.name) return ['allowUserWords', exactRule(info.name)];
            const text = plainText(info.body, info.reply);
            return text ? ['allowCommentWords', exactRule(text)] : null;
        }
        if (info.id) return [allowField(`${info.type}Ids`), info.id];
        if (info.type === 'author' && info.uid) return ['allowAuthorUids', info.uid];
        return info.type === 'author' && info.label ? ['allowAuthorWords', exactRule(info.label)] : null;
    }

    async function authorsFor(info) {
        if (!info || !['mod', 'pack'].includes(info.type)) return [];
        const inline = projectAuthors(info.scope ?? info.target);
        return inline.length ? inline : loadAuthors(info);
    }

    function exactRule(text) {
        return '/^' + text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/\n/g, '\\n') + '$/';
    }

    function ruleFromReason(reason) {
        for (const [field, label] of Object.entries(blockFields)) {
            if (reason.startsWith(label + ' ')) return [field, reason.slice(label.length + 1)];
        }
        return null;
    }

    function addManual(node) {
        manual.add(node);
        hasManual = true;
        scan();
    }

    function record(node, hit) {
        const info = hit.info;
        const comments = info?.type === 'comment';
        if (!seenNodes.has(node)) seenNodes.set(node, ++nodeSequence);
        const itemKey = info?.id ? `${comments ? location.pathname : ''}:${info.type}:${info.id}` : seenNodes.get(node);
        const key = `${itemKey}:${hit.reason}`;
        if (hits.has(key)) return false;
        const pass = hit.inherited ? null : passFor(info);
        hits.set(key, { ...hit, pass, comment: comments, info: {
            url: info?.url, label: info?.label || hit.label, uid: info?.uid,
        }, release: hit.reason === '手动' ? () => { manual.delete(node); scan(); } : null });
        if (hits.size > 300) hits.delete(hits.keys().next().value);
        sessionHits++;
        return true;
    }

    function clearNotice(node) {
        commentSlot(node)?.querySelector(':scope > .mcf-comment-banner')?.remove();
        node.classList.remove('mcf-comment-review');
    }

    function markReview(node, hit) {
        node.classList.add('mcf-marked');
        const tag = node.querySelector(':scope > .mcf-review-label');
        if (tag?.dataset.reason === hit.reason) return;
        tag?.remove();
        const el = make('span', '', { className: 'mcf-review-label' });
        el.dataset.mcfUi = '';
        el.dataset.reason = hit.reason;
        const text = make('span', hit.reason, { title: hit.reason });
        const pass = passFor(hit.info);
        el.append(text);
        if (pass || hit.reason === '手动') {
            el.append(button('放行', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (pass) ui.allow(pass, hit.label);
                else { manual.delete(node); scan(); }
            }));
        }
        node.prepend(el);
    }

    function scan() {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        const next = new Map();
        const detailTarget = document.querySelector('.common-center > .center');
        if (settings.raw.enabled && !revealPage) {
            if (settings.hasProjectRules) markDetail(next);
            if (!detailTarget || !next.has(detailTarget) || settings.raw.reviewMode) {
                const cards = settings.hasProjectRules || hasManual ? pageCards() : [];
                for (const card of cards) {
                    if (revealed.has(card)) continue;
                    const info = readCard(card);
                    if (!info) continue;
                    const reason = matchItem(info, info.names, card) ||
                        (manual.has(card) && !entryAllowed(info, info.names) ? '手动' : '');
                    if (reason) next.set(card, { reason, label: info.label, mode: 'hide', info });
                }
                if (home && (settings.hasProjectRules || settings.hasCommentRules)) {
                    for (const row of document.querySelectorAll(':is(.topic_block,.block_topic) .item')) {
                        const reason = matchActivity(row);
                        if (!reason) continue;
                        const topic = row.querySelector('.dec > a');
                        const profile = row.querySelector(':scope > a');
                        const isComment = /^(?:user|comment)/.test(ruleFromReason(reason)?.[0] ?? '');
                        const info = isComment ? {
                            type: 'comment', uid: uidFromLink(profile?.href), name: profile?.title,
                            body: row.querySelector('.dec > span'),
                        } : entry(topic?.href);
                        next.set(row, { reason, label: topic?.title, mode: 'hide', info });
                    }
                }
                if (detail && detail.type !== 'author' && settings.hasAuthorRules) {
                    for (const row of document.querySelectorAll(projectAuthorSelector)) {
                        const author = projectAuthor(row);
                        const reason = authorAllowed(author) ? '' : authorMatch(author);
                        if (reason) next.set(row, {
                            reason, label: author.names[0], mode: 'hide', info: { ...author, type: 'author' },
                        });
                    }
                }
                markComments(next);
            }
        }
        if (!detailTarget || !next.has(detailTarget) || settings.raw.reviewMode) {
            detailNotice?.remove();
            detailNotice = null;
        }
        for (const node of marked.keys()) {
            if (!next.has(node) || settings.raw.reviewMode) delete node.dataset.mcfFiltered;
            if (!next.has(node) && marked.get(node).commentRow) clearNotice(node);
            if (!next.has(node) || !settings.raw.reviewMode) {
                node.classList.remove('mcf-marked');
                node.querySelector(':scope > .mcf-review-label')?.remove();
            }
        }
        let change = 0;
        for (const [node, hit] of next) {
            if (settings.raw.reviewMode) {
                if (!hit.commentRow) markReview(node, hit);
            } else if (node.dataset.mcfFiltered !== hit.mode) {
                node.dataset.mcfFiltered = hit.mode;
            }
            if (hit.commentRow) renderComment(node, hit);
            change += Number(record(node, hit));
        }
        if (change) {
            totalHits = (Number(GM_getValue(countKey, 0)) || 0) + change;
            GM_setValue(countKey, totalHits);
        }
        marked = next;
        for (const [card, url] of observed) {
            if (settings.raw.enabled && settings.raw.resolveAuthors && card.isConnected &&
                !marked.has(card) && !authorCache.has(url)) continue;
            visibilityObserver.unobserve(card);
            observed.delete(card);
            visible.delete(card);
        }
        ui?.sync();
    }

    function queueScan() {
        if (!frame) frame = requestAnimationFrame(scan);
    }

    function applySettings(value) {
        settings = value;
        revealPage = false;
        scan();
    }

    function commit(raw) {
        const value = parseSettings(raw);
        GM_setValue(storageKey, value.raw);
        applySettings(value);
    }

    function pageType() {
        if (detail) return categories[detail.type] + '详情';
        if (home) return '首页';
        if (location.hostname === 'search.mcmod.cn') return '搜索';
        if (location.pathname.startsWith('/class/category/')) return '模组分类';
        if (location.pathname.startsWith('/modpack/category/')) return '整合包分类';
        if (location.pathname === '/modlist.html') return '模组检索';
        if (location.pathname === '/modpack.html') return '整合包检索';
        return '主站';
    }

    function toggleReveal() {
        revealPage = !revealPage;
        scan();
    }

    const css = make('style', `
        [data-mcf-filtered="hide"], [data-mcf-filtered="detail"] { display: none !important; }
        .mcf-comment-review > .comment-row-content > .comment-row-text {
            max-height:none!important;overflow:visible!important;
        }
        .mcf-comment-review > .comment-row-content > .fold {
            display:none!important;
        }
        .mcf-notice { display:flex;align-items:center;justify-content:space-between;gap:8px;
            margin:4px 0;padding:6px 9px;color:#555;background:#f5f5f5;border-radius:8px;font-size:12px; }
        .mcf-notice button { border:0;border-radius:6px;background:#fff;color:#1b7a3d;cursor:pointer;white-space:nowrap; }
        [data-mcf-ui] { --mcf-green: #5d9232; --mcf-ink: #232b21; --mcf-line: #dce6d5; --mcf-tint: #edf4e8; }
        [data-mcf-ui][hidden], [data-mcf-ui] [hidden] { display: none !important; }
        :is(#mcf-panel,#mcf-badge,#mcf-menu,#mcf-hover,#mcf-confirm,#mcf-messages) { font: 14px/1.45 system-ui,sans-serif; }
        #mcf-badge { position:fixed;right:18px;bottom:18px;z-index:99999;border:0;border-radius:999px;
            padding:9px 15px;background:var(--mcf-green);color:#fff;font-weight:650;cursor:grab;touch-action:none;
            user-select:none;box-shadow:0 4px 15px #0003;max-width:calc(100vw - 16px); }
        #mcf-badge.is-dragging { cursor:grabbing; }
        #mcf-badge.is-locked { cursor:pointer;touch-action:manipulation; }
        #mcf-badge.is-paused { background:#626a5f; }
        #mcf-panel { position:fixed;inset:0 0 0 auto;z-index:100000;width:min(400px,94vw);box-sizing:border-box;
            transform:translateX(100%);visibility:hidden;transition:transform .2s ease,visibility .2s;
            overflow:auto;overscroll-behavior:contain;background:#fff;color:var(--mcf-ink);box-shadow:-6px 0 22px #0003; }
        #mcf-panel.is-open { transform:translateX(0);visibility:visible; }
        #mcf-panel input,#mcf-panel select,#mcf-panel textarea,#mcf-confirm select { box-sizing:border-box;
            background:white;color:var(--mcf-ink);border:1px solid #cbd7c6;border-radius:7px;min-width:0;font:inherit;padding:6px 8px; }
        #mcf-panel input[type=checkbox] { width:16px;height:16px;accent-color:var(--mcf-green);flex:none;margin:0; }
        #mcf-panel input:focus,#mcf-panel textarea:focus,#mcf-panel select:focus,#mcf-confirm select:focus {
            outline:2px solid #b9d1aa;outline-offset:1px; }
        :is(#mcf-panel,#mcf-menu,#mcf-hover,#mcf-confirm,#mcf-messages) button {
            border:1px solid var(--mcf-line);background:#fff;color:var(--mcf-ink);cursor:pointer;border-radius:7px;
            padding:5px 9px;font:inherit; }
        :is(#mcf-panel,#mcf-menu,#mcf-confirm,#mcf-messages) button:hover { background:var(--mcf-tint); }
        :is(#mcf-panel,#mcf-menu,#mcf-hover,#mcf-confirm,#mcf-messages) button:focus-visible {
            outline:2px solid var(--mcf-green);outline-offset:2px; }
        :is(#mcf-panel,#mcf-confirm,#mcf-messages) :is(.mcf-primary,.mcf-toast-action) {
            background:var(--mcf-green);border-color:var(--mcf-green);color:#fff;font-weight:650; }
        :is(#mcf-panel,#mcf-confirm,#mcf-messages) :is(.mcf-primary,.mcf-toast-action):hover { background:#4a752a; }
        .mcf-header { position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:8px;
            background:linear-gradient(125deg,#5d9232,#76a34e);color:white;padding:12px 14px; }
        #mcf-panel .mcf-header h2 { font:700 16px/1.25 system-ui,sans-serif;color:inherit;margin:0;flex:1; }
        .mcf-header small { font-size:11px;white-space:nowrap; }
        #mcf-panel .mcf-header button { background:transparent;color:white;border:0;font-size:16px;padding:4px; }
        .mcf-tabs { display:flex;justify-content:center;flex-wrap:wrap;gap:6px;padding:10px 12px; }
        #mcf-panel .mcf-tabs button { font-size:12px;font-weight:650;border-radius:999px;background:#f1f3ef; }
        #mcf-panel .mcf-tabs [aria-pressed=true] { background:var(--mcf-green);color:white;border-color:var(--mcf-green); }
        .mcf-finder { display:flex;align-items:center;gap:6px;border-top:1px solid var(--mcf-line);
            border-bottom:1px solid var(--mcf-line);padding:8px 13px; }
        .mcf-finder input { flex:1; }
        .mcf-finder span { font-size:11px;white-space:nowrap; }
        .mcf-section { margin:0;padding:12px 14px;min-width:0;border-bottom:1px solid #eaf0e6; }
        .mcf-section.mcf-allow { background:#f6faf4; }
        #mcf-panel .mcf-section h3 { font:700 14px/1.4 system-ui,sans-serif;margin:0 0 8px;color:inherit; }
        #mcf-panel .mcf-switch { display:flex;align-items:flex-start;gap:8px;font-weight:500;margin:7px 0;cursor:pointer; }
        #mcf-panel .mcf-switch input { margin-top:2px; }
        #mcf-panel .mcf-hint { font-size:12px;color:#5f6959;margin:6px 0;overflow-wrap:anywhere; }
        .mcf-field summary { font-size:13px;font-weight:700;cursor:pointer;width:max-content;max-width:100%; }
        .mcf-count { font-size:11px;color:#426129;background:var(--mcf-tint);padding:1px 6px;border-radius:999px; }
        .mcf-add-rule { display:flex;gap:6px;margin:9px 0; }
        .mcf-add-rule input { flex:1; }
        .mcf-add-rule button { flex:none; }
        .mcf-field-search,.mcf-section>input[type=text],.mcf-section>textarea { display:block;width:100%;margin:6px 0; }
        .mcf-rules { display:flex;flex-wrap:wrap;gap:5px;margin-top:6px;max-height:205px;overflow:auto; }
        .mcf-rule { display:inline-flex;align-items:center;gap:3px;max-width:100%;border:1px solid var(--mcf-line);
            border-radius:12px;background:var(--mcf-tint);color:#355024;font-size:12px;padding:2px 5px 2px 7px; }
        .mcf-rule>span { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
        .mcf-rule.is-disabled { background:#f1f1f1;color:#555;text-decoration:line-through; }
        #mcf-panel .mcf-rule button { padding:1px 3px;border:0;background:none;color:inherit;font-size:11px; }
        .mcf-tools-row { display:flex;gap:5px;flex-wrap:wrap; }
        .mcf-tools-row button { font-size:12px !important; }
        .mcf-log { max-height:280px;overflow:auto;overscroll-behavior:contain; }
        .mcf-hit { display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 6px;border-top:1px solid var(--mcf-line);
            padding:6px 0;font-size:12px; }
        .mcf-hit small { grid-column:1/-1;color:#426129;overflow-wrap:anywhere; }
        .mcf-hit>span,.mcf-hit>a { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
        .mcf-hit a { color:#426129; }
        #mcf-menu { position:fixed;z-index:100005;display:grid;min-width:205px;max-width:calc(100vw - 16px);padding:4px;
            border:1px solid var(--mcf-line);border-radius:10px;box-shadow:0 8px 24px #0003;background:white; }
        #mcf-menu button { text-align:left;border:0;padding:8px 10px; }
        #mcf-menu button:hover { color:#426129; }
        #mcf-hover { position:fixed;z-index:99998;display:grid;justify-items:start;gap:4px; }
        #mcf-hover button { padding:4px 8px;background:var(--mcf-green);color:#fff;border:0;box-shadow:0 2px 7px #0004;font-size:12px; }
        #mcf-hover button:last-child { background:#283328; }
        #mcf-messages { position:fixed;z-index:100006;right:16px;bottom:64px;max-width:min(355px,calc(100vw - 32px)); }
        .mcf-toast { display:flex;align-items:center;gap:8px;padding:9px 10px;color:#273225;background:#fff;
            border:1px solid var(--mcf-line);border-left:4px solid var(--mcf-green);border-radius:9px;box-shadow:0 5px 18px #0002; }
        .mcf-toast>span { overflow-wrap:anywhere; }
        .mcf-toast.is-error { border-left-color:#a33c34; }
        #mcf-messages .mcf-icon { border:0;background:transparent;padding:2px 4px; }
        #mcf-confirm { width:min(390px,calc(100vw - 28px));padding:0;box-sizing:border-box;border:1px solid var(--mcf-line);
            border-radius:12px;color:var(--mcf-ink);background:white;box-shadow:0 12px 32px #0004; }
        #mcf-confirm::backdrop { background:#17221380; }
        #mcf-confirm h3 { font-size:15px;color:white;margin:0;padding:12px 14px;background:var(--mcf-green); }
        #mcf-confirm.is-danger h3,#mcf-confirm .mcf-danger { background:#a13a33;color:#fff;border-color:#a13a33; }
        #mcf-confirm p { margin:12px 14px;overflow-wrap:anywhere; }
        #mcf-confirm select { margin:0 14px 10px;width:calc(100% - 28px); }
        #mcf-confirm .mcf-tools-row { justify-content:flex-end;padding:0 14px 12px; }
        .mcf-marked { outline:2px solid #5d9232 !important;outline-offset:-2px;position:relative !important; }
        .mcf-review-label { position:absolute;z-index:5;top:4px;left:4px;max-width:calc(100% - 8px);display:inline-flex;
            gap:4px;align-items:center;background:#5d9232;color:white;padding:2px 6px;border-radius:5px;font:12px/1.45 system-ui; }
        .mcf-review-label span { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
        .mcf-review-label button { background:white;color:#365723;border:0;border-radius:4px;white-space:nowrap;cursor:pointer; }
        .common-comment-block .mcf-comment-banner { box-sizing:border-box;display:flex;
            align-items:center;justify-content:space-between;gap:8px;margin:0 0 8px;padding:5px 8px;
            border-radius:6px;border-left:3px solid #5d9232;background:#edf4e8;color:#365723;
            font:12px/1.5 system-ui,sans-serif; }
        .common-comment-block .mcf-comment-banner span { min-width:0;overflow-wrap:anywhere; }
        .common-comment-block .mcf-comment-banner button { flex:none;white-space:nowrap;border:1px solid #c9dac0;
            border-radius:5px;padding:2px 7px;background:#fff;color:#365723;font:inherit;cursor:pointer; }
        @media (prefers-reduced-motion: reduce) { #mcf-panel { transition:none; } }
    `);
    document.head.append(css);
    ui = installUi({
        defaults, fields, idFields, blockFields, allowField, splitField, wordRule, parseSettings,
        current: () => settings, commit, toggleReveal, revealPage: () => revealPage,
        hits: () => [...hits.values()].reverse(), sessionHits: () => sessionHits, totalHits: () => totalHits,
        pageCards, readCard, context, addManual, ruleFromReason, passFor, pageType, authorsFor,
    });
    GM_addValueChangeListener(storageKey, (_key, _old, value, remote) => {
        if (remote) {
            applySettings(parseSettings(value ?? {}, true));
            ui.remoteSync();
        }
    });
    GM_addValueChangeListener(countKey, (_key, _old, value, remote) => {
        if (remote) {
            totalHits = Number(value) || 0;
            ui.sync();
        }
    });

    new MutationObserver((records) => {
        if (!settings.raw.enabled || revealPage) return;
        const outsideUi = node => !((node.nodeType === 1 ? node : node.parentElement)?.closest(
            '[data-mcf-ui]',
        ));
        if (records.some(record => outsideUi(record.target) && (record.type !== 'childList' ||
            [...record.addedNodes, ...record.removedNodes].some(outsideUi)))) queueScan();
    }).observe(document.body, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['href', 'data-uid', 'src', 'title'],
    });
    scan();
})();
