'use strict';

const sourcesRoot = document.getElementById('sources');
document.getElementById('cancel').addEventListener('click', () => window.sourcePicker.cancel());
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.sourcePicker.cancel();
});

window.sourcePicker.onSources((sources) => {
    sourcesRoot.replaceChildren();
    for (const kind of ['window', 'screen']) {
        const matching = sources.filter((source) => source.kind === kind);
        if (!matching.length) continue;

        const section = document.createElement('section');
        const title = document.createElement('h2');
        title.textContent = kind === 'window' ? 'Janelas · áudio da aplicação' : 'Telas inteiras · áudio do sistema';
        const grid = document.createElement('div');
        grid.className = 'grid';

        for (const source of matching) {
            const button = document.createElement('button');
            button.className = 'source';
            button.type = 'button';
            button.title = source.name;
            button.addEventListener('click', () => window.sourcePicker.select(source.id));

            const preview = document.createElement('img');
            preview.src = source.thumbnail;
            preview.alt = '';

            const label = document.createElement('div');
            label.className = 'label';
            if (source.appIcon) {
                const icon = document.createElement('img');
                icon.src = source.appIcon;
                icon.alt = '';
                label.appendChild(icon);
            }
            const name = document.createElement('span');
            name.className = 'name';
            name.textContent = source.name;
            const badge = document.createElement('span');
            badge.className = 'badge';
            badge.textContent = kind === 'window' ? 'APLICAÇÃO' : 'SISTEMA';
            label.append(name, badge);
            button.append(preview, label);
            grid.appendChild(button);
        }
        section.append(title, grid);
        sourcesRoot.appendChild(section);
    }
    if (!sourcesRoot.children.length) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'Nenhuma fonte de captura foi encontrada.';
        sourcesRoot.appendChild(empty);
    }
});
