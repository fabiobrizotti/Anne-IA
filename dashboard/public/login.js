'use strict';

document.addEventListener('DOMContentLoaded', () => {
  // ---------------------------------------------------------------------------
  // 1. TEMA CLARO / ESCURO
  // ---------------------------------------------------------------------------
  const btnTheme = document.getElementById('btn-theme-toggle');
  const iconSun = document.getElementById('theme-icon-sun');
  const iconMoon = document.getElementById('theme-icon-moon');

  function updateThemeUI(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    if (theme === 'dark') {
      iconSun.classList.remove('hidden');
      iconMoon.classList.add('hidden');
    } else {
      iconSun.classList.add('hidden');
      iconMoon.classList.remove('hidden');
    }
  }

  const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
  updateThemeUI(currentTheme);

  if (btnTheme) {
    btnTheme.addEventListener('click', () => {
      const active = document.documentElement.getAttribute('data-theme');
      const next = active === 'dark' ? 'light' : 'dark';
      localStorage.setItem('anne_theme', next);
      updateThemeUI(next);
    });
  }

  // ---------------------------------------------------------------------------
  // 2. ALTERNÂNCIA DE ABAS (ENTRAR / CRIAR CONTA)
  // ---------------------------------------------------------------------------
  const tabLogin = document.getElementById('tab-btn-login');
  const tabRegister = document.getElementById('tab-btn-register');
  const paneLogin = document.getElementById('pane-login');
  const paneRegister = document.getElementById('pane-register');
  const alertBox = document.getElementById('auth-alert');

  function showAlert(msg, isSuccess = false) {
    if (!alertBox) return;
    alertBox.textContent = msg;
    alertBox.className = `auth-alert ${isSuccess ? 'auth-alert-success' : 'auth-alert-error'}`;
    alertBox.classList.remove('hidden');
  }

  function hideAlert() {
    if (!alertBox) return;
    alertBox.classList.add('hidden');
    alertBox.textContent = '';
  }

  function switchTab(target) {
    hideAlert();
    if (target === 'register') {
      tabLogin.classList.remove('active');
      tabLogin.setAttribute('aria-selected', 'false');
      tabRegister.classList.add('active');
      tabRegister.setAttribute('aria-selected', 'true');
      paneLogin.classList.remove('active');
      paneLogin.hidden = true;
      paneRegister.classList.add('active');
      paneRegister.hidden = false;
      const firstInput = document.getElementById('reg-nome');
      if (firstInput) firstInput.focus();
    } else {
      tabRegister.classList.remove('active');
      tabRegister.setAttribute('aria-selected', 'false');
      tabLogin.classList.add('active');
      tabLogin.setAttribute('aria-selected', 'true');
      paneRegister.classList.remove('active');
      paneRegister.hidden = true;
      paneLogin.classList.add('active');
      paneLogin.hidden = false;
      const firstInput = document.getElementById('login-identifier');
      if (firstInput) firstInput.focus();
    }
  }

  if (tabLogin) tabLogin.addEventListener('click', () => switchTab('login'));
  if (tabRegister) tabRegister.addEventListener('click', () => switchTab('register'));

  // ---------------------------------------------------------------------------
  // 3. TOGGLE DE VISIBILIDADE DE SENHA (SVG EYE)
  // ---------------------------------------------------------------------------
  document.querySelectorAll('.btn-toggle-password').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const input = document.getElementById(targetId);
      if (!input) return;

      const isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';

      const eyeOpen = btn.querySelector('.eye-open');
      const eyeClosed = btn.querySelector('.eye-closed');
      if (eyeOpen && eyeClosed) {
        if (isPassword) {
          eyeOpen.classList.add('hidden');
          eyeClosed.classList.remove('hidden');
        } else {
          eyeOpen.classList.remove('hidden');
          eyeClosed.classList.add('hidden');
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 4. MÁSCARAS E VALIDAÇÕES (CPF, TELEFONE, IDADE, SENHA)
  // ---------------------------------------------------------------------------
  const inputCpf = document.getElementById('reg-cpf');
  const cpfFeedback = document.getElementById('cpf-validation-msg');

  function validateCpfClient(cpf) {
    const clean = String(cpf || '').replace(/\D/g, '');
    if (clean.length !== 11) return false;
    if (/^(\d)\1{10}$/.test(clean)) return false;
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += parseInt(clean[i], 10) * (10 - i);
    let rem = (sum * 10) % 11;
    if (rem === 10 || rem === 11) rem = 0;
    if (rem !== parseInt(clean[9], 10)) return false;
    sum = 0;
    for (let i = 0; i < 10; i++) sum += parseInt(clean[i], 10) * (11 - i);
    rem = (sum * 10) % 11;
    if (rem === 10 || rem === 11) rem = 0;
    return rem === parseInt(clean[10], 10);
  }

  function maskCpf(v) {
    return v
      .replace(/\D/g, '')
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d{1,2})$/, '$1-$2')
      .substring(0, 14);
  }

  if (inputCpf) {
    inputCpf.addEventListener('input', (e) => {
      e.target.value = maskCpf(e.target.value);
      const digits = e.target.value.replace(/\D/g, '');
      if (digits.length === 11) {
        if (validateCpfClient(digits)) {
          cpfFeedback.textContent = '✓ CPF válido';
          cpfFeedback.className = 'field-feedback feedback-valid';
        } else {
          cpfFeedback.textContent = '✕ CPF inválido';
          cpfFeedback.className = 'field-feedback feedback-invalid';
        }
      } else {
        cpfFeedback.textContent = '';
      }
    });
  }

  const inputPhone = document.getElementById('reg-telefone');
  if (inputPhone) {
    inputPhone.addEventListener('input', (e) => {
      let v = e.target.value.replace(/\D/g, '');
      if (v.length > 11) v = v.substring(0, 11);
      if (v.length > 10) {
        e.target.value = v.replace(/^(\d{2})(\d{5})(\d{4})$/, '($1) $2-$3');
      } else if (v.length > 6) {
        e.target.value = v.replace(/^(\d{2})(\d{4})(\d{0,4})$/, '($1) $2-$3');
      } else if (v.length > 2) {
        e.target.value = v.replace(/^(\d{2})(\d{0,5})$/, '($1) $2');
      } else {
        e.target.value = v;
      }
    });
  }

  // Medidor de Força de Senha
  const inputPwd = document.getElementById('reg-password');
  const inputPwdConfirm = document.getElementById('reg-password-confirm');
  const pwdMatchFeedback = document.getElementById('pwd-match-feedback');
  const meterBars = [
    document.getElementById('meter-bar-1'),
    document.getElementById('meter-bar-2'),
    document.getElementById('meter-bar-3'),
    document.getElementById('meter-bar-4')
  ];
  const meterText = document.getElementById('meter-text');

  function calculatePasswordStrength(pass) {
    let score = 0;
    if (!pass) return { score: 0, label: 'Vazia' };
    if (pass.length >= 8) score++;
    if (/[a-z]/.test(pass) && /[A-Z]/.test(pass)) score++;
    if (/[0-9]/.test(pass)) score++;
    if (/[^a-zA-Z0-9]/.test(pass) || pass.length >= 12) score++;

    const labels = ['Fraca', 'Regular', 'Forte', 'Excelente'];
    return { score, label: labels[Math.max(0, score - 1)] || 'Fraca' };
  }

  function updateStrengthMeter(pass) {
    const { score, label } = calculatePasswordStrength(pass);
    if (meterText) meterText.textContent = label;

    meterBars.forEach((bar, idx) => {
      if (!bar) return;
      bar.className = 'meter-bar';
      if (pass.length > 0 && idx < score) {
        if (score === 1) bar.classList.add('bar-weak');
        else if (score === 2) bar.classList.add('bar-fair');
        else if (score === 3) bar.classList.add('bar-good');
        else bar.classList.add('bar-strong');
      }
    });
  }

  if (inputPwd) {
    inputPwd.addEventListener('input', (e) => {
      updateStrengthMeter(e.target.value);
      checkPasswordMatch();
    });
  }

  function checkPasswordMatch() {
    if (!inputPwd || !inputPwdConfirm || !pwdMatchFeedback) return;
    const p1 = inputPwd.value;
    const p2 = inputPwdConfirm.value;
    if (!p2) {
      pwdMatchFeedback.textContent = '';
      return;
    }
    if (p1 === p2) {
      pwdMatchFeedback.textContent = '✓ Senhas coincidem';
      pwdMatchFeedback.className = 'field-feedback feedback-valid';
    } else {
      pwdMatchFeedback.textContent = '✕ As senhas não conferem';
      pwdMatchFeedback.className = 'field-feedback feedback-invalid';
    }
  }

  if (inputPwdConfirm) {
    inputPwdConfirm.addEventListener('input', checkPasswordMatch);
  }

  // ---------------------------------------------------------------------------
  // 5. SUBMISSÃO DE LOGIN
  // ---------------------------------------------------------------------------
  const formLogin = document.getElementById('form-login');
  const btnLoginSubmit = document.getElementById('btn-login-submit');

  if (formLogin) {
    formLogin.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideAlert();

      const identifier = document.getElementById('login-identifier')?.value.trim();
      const password = document.getElementById('login-password')?.value;
      const rememberMe = document.getElementById('login-remember')?.checked;

      if (!identifier || !password) {
        showAlert('Preencha seu e-mail/código e senha de acesso.');
        return;
      }

      setButtonLoading(btnLoginSubmit, true);

      try {
        const res = await fetch('/api/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier,
            password,
            remember_me: !!rememberMe
          })
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok || !data.success) {
          showAlert(data.error || 'Credenciais inválidas. Tente novamente.');
          setButtonLoading(btnLoginSubmit, false);
          return;
        }

        showAlert('Autenticado com sucesso. Redirecionando...', true);
        setTimeout(() => {
          window.location.href = '/';
        }, 500);
      } catch (err) {
        showAlert('Erro de conexão com o servidor. Verifique sua rede.');
        setButtonLoading(btnLoginSubmit, false);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 6. SUBMISSÃO DE CADASTRO (SIGN UP)
  // ---------------------------------------------------------------------------
  const formRegister = document.getElementById('form-register');
  const btnRegSubmit = document.getElementById('btn-register-submit');

  if (formRegister) {
    formRegister.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideAlert();

      const nome = document.getElementById('reg-nome')?.value.trim();
      const cpf = document.getElementById('reg-cpf')?.value.trim();
      const dataNascimento = document.getElementById('reg-nascimento')?.value;
      const email = document.getElementById('reg-email')?.value.trim();
      const telefone = document.getElementById('reg-telefone')?.value.trim();
      const password = document.getElementById('reg-password')?.value;
      const passwordConfirm = document.getElementById('reg-password-confirm')?.value;
      const aceitouTermos = document.getElementById('reg-termos')?.checked;
      const aceitouPrivacidade = document.getElementById('reg-privacidade')?.checked;

      if (!nome || nome.split(/\s+/).length < 2) {
        showAlert('Informe seu nome completo (nome e sobrenome).');
        return;
      }

      if (!validateCpfClient(cpf)) {
        showAlert('CPF informado é inválido. Verifique os números.');
        return;
      }

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showAlert('Informe um e-mail corporativo válido.');
        return;
      }

      if (!password || password.length < 8) {
        showAlert('A senha deve conter no mínimo 8 caracteres.');
        return;
      }

      if (password !== passwordConfirm) {
        showAlert('A confirmação de senha não confere com a senha digitada.');
        return;
      }

      if (!aceitouTermos || !aceitouPrivacidade) {
        showAlert('É obrigatório aceitar os Termos de Uso e a Política de Privacidade (LGPD).');
        return;
      }

      setButtonLoading(btnRegSubmit, true);

      try {
        const res = await fetch('/api/v1/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nome,
            cpf,
            data_nascimento: dataNascimento || null,
            email,
            telefone,
            password,
            aceitou_termos: true,
            aceitou_privacidade: true
          })
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok || !data.success) {
          showAlert(data.error || 'Falha ao registrar novo usuário.');
          setButtonLoading(btnRegSubmit, false);
          return;
        }

        showAlert('Conta criada com sucesso! Acessando a plataforma...', true);
        setTimeout(() => {
          window.location.href = '/';
        }, 600);
      } catch (err) {
        showAlert('Erro de conexão ao criar conta. Tente novamente.');
        setButtonLoading(btnRegSubmit, false);
      }
    });
  }

  function setButtonLoading(btn, isLoading) {
    if (!btn) return;
    const txt = btn.querySelector('.btn-text');
    const spinner = btn.querySelector('.btn-spinner');
    btn.disabled = isLoading;
    if (isLoading) {
      if (spinner) spinner.classList.remove('hidden');
    } else {
      if (spinner) spinner.classList.add('hidden');
    }
  }

  // ---------------------------------------------------------------------------
  // 7. MODAIS (TERMOS LGPD E ESQUECI MINHA SENHA)
  // ---------------------------------------------------------------------------
  const modalLegal = document.getElementById('modal-legal');
  const modalLegalTitle = document.getElementById('modal-legal-title');
  const modalLegalVersion = document.getElementById('modal-legal-version');
  const modalLegalContent = document.getElementById('modal-legal-content');
  const btnCloseLegal = document.getElementById('btn-close-legal');
  const btnModalLegalOk = document.getElementById('btn-modal-legal-ok');

  async function openLegalModal(docType) {
    if (!modalLegal) return;
    modalLegalTitle.textContent = 'Carregando documento...';
    modalLegalContent.textContent = 'Consultando versão canônica LGPD no servidor...';
    modalLegal.classList.remove('hidden');

    try {
      const res = await fetch(`/api/v1/auth/legal/${docType}`);
      const json = await res.json();
      if (json.success && json.data) {
        modalLegalTitle.textContent = json.data.titulo;
        modalLegalVersion.textContent = `Versão ${json.data.versao} — Atualizado em ${json.data.data}`;
        modalLegalContent.textContent = json.data.conteudo;
      } else {
        modalLegalContent.textContent = 'Documento indisponível no momento.';
      }
    } catch (_e) {
      modalLegalContent.textContent = 'Falha ao carregar texto legal do servidor.';
    }
  }

  document.querySelectorAll('.btn-legal-view').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const doc = btn.getAttribute('data-legal');
      openLegalModal(doc);
    });
  });

  function closeLegalModal() {
    if (modalLegal) modalLegal.classList.add('hidden');
  }
  if (btnCloseLegal) btnCloseLegal.addEventListener('click', closeLegalModal);
  if (btnModalLegalOk) btnModalLegalOk.addEventListener('click', closeLegalModal);

  // Modal Forgot
  const modalForgot = document.getElementById('modal-forgot');
  const btnForgot = document.getElementById('btn-forgot-password');
  const btnCloseForgot = document.getElementById('btn-close-forgot');
  const btnModalForgotOk = document.getElementById('btn-modal-forgot-ok');

  if (btnForgot) {
    btnForgot.addEventListener('click', () => {
      if (modalForgot) modalForgot.classList.remove('hidden');
    });
  }

  function closeForgotModal() {
    if (modalForgot) modalForgot.classList.add('hidden');
  }
  if (btnCloseForgot) btnCloseForgot.addEventListener('click', closeForgotModal);
  if (btnModalForgotOk) btnModalForgotOk.addEventListener('click', closeForgotModal);

  // Fechar modais ao clicar no backdrop ou pressionar Escape
  [modalLegal, modalForgot].forEach(modal => {
    if (!modal) return;
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeLegalModal();
      closeForgotModal();
    }
  });
});
