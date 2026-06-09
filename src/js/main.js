async function carregarComponente(id, caminho) {
    const elemento = document.getElementById(id);

    if (!elemento) {
        return;
    }

    const resposta = await fetch(caminho);
    const html = await resposta.text();

    elemento.innerHTML = html;
}
carregarComponente("login", "src/pages/login.html");
carregarComponente("dashboard", "src/pages/dashboard.html");
