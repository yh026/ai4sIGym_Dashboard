/* Click-to-load introduction: inline on desktop and fullscreen on mobile. */
(() => {
  const trigger = document.getElementById('gym-intro-trigger');
  const dialog = document.getElementById('gym-intro-dialog');
  const frame = document.getElementById('gym-intro-frame');
  const shell = document.getElementById('gym-intro-shell');
  const video = document.getElementById('gym-intro-video');
  const close = document.getElementById('gym-intro-close');
  const status = document.getElementById('gym-intro-status');
  const label = document.getElementById('gym-intro-play-label');
  let mobile = false;
  let mobileFullscreen = false;
  let nativeFullscreenPending = false;
  let orientationLocked = false;
  let previousOverflow = '';

  function unlockOrientation() {
    if (orientationLocked) {
      try { screen.orientation.unlock(); } catch (_) {}
      orientationLocked = false;
    }
  }

  function closeIntro() {
    if (!dialog.open) return;
    video.pause();
    nativeFullscreenPending = false;
    mobileFullscreen = false;
    dialog.close();
    document.body.style.overflow = previousOverflow;
    unlockOrientation();
    if (document.fullscreenElement && shell.contains(document.fullscreenElement)) document.exitFullscreen().catch(() => {});
    if (video.webkitDisplayingFullscreen && video.webkitExitFullscreen) {
      try { video.webkitExitFullscreen(); } catch (_) {}
    }
    frame.appendChild(shell);
    trigger.hidden = false;
    video.setAttribute('aria-hidden', 'true');
    video.tabIndex = -1;
    label.textContent = video.ended ? 'Watch again' : 'Continue watching';
    trigger.setAttribute('aria-label', video.ended ? 'Watch the introduction again' : 'Continue the introduction');
    trigger.focus({ preventScroll: true });
  }

  async function lockLandscape() {
    if (!mobile || !screen.orientation?.lock) return;
    try {
      await screen.orientation.lock('landscape');
      orientationLocked = true;
      if (!dialog.open) unlockOrientation();
    } catch (_) {}
  }

  function enterNativeFullscreen() {
    if (!nativeFullscreenPending || !dialog.open) return;
    try {
      video.webkitEnterFullscreen();
      nativeFullscreenPending = false;
    } catch (_) {}
  }

  function requestMobileFullscreen() {
    if (video.webkitEnterFullscreen) {
      nativeFullscreenPending = true;
      enterNativeFullscreen();
    } else if (shell.requestFullscreen) {
      shell.requestFullscreen({ navigationUI: 'hide' }).then(() => {
        if (!dialog.open) {
          if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
          return;
        }
        mobileFullscreen = true;
        return lockLandscape();
      }).catch(() => {});
    }
  }

  trigger.addEventListener('click', () => {
    mobile = window.matchMedia('(pointer: coarse)').matches;
    status.hidden = true;
    trigger.hidden = true;
    if (mobile) {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      dialog.appendChild(shell);
      dialog.showModal();
    }
    video.controls = true;
    video.removeAttribute('aria-hidden');
    video.tabIndex = 0;
    if (!video.hasAttribute('src')) {
      video.poster = video.dataset.introPoster;
      video.src = video.dataset.introSrc;
    }
    if (video.ended) video.currentTime = 0;
    const playing = video.play();
    if (mobile) requestMobileFullscreen();
    else video.focus({ preventScroll: true });
    playing?.catch(error => {
      if (error.name === 'AbortError' || (mobile && !dialog.open)) return;
      status.textContent = error.name === 'NotAllowedError'
        ? 'Press play in the video controls to start the introduction.'
        : 'The introduction could not load. Refresh the page and try again.';
      status.hidden = false;
    });
  });

  close.addEventListener('click', closeIntro);
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeIntro(); });
  video.addEventListener('loadedmetadata', enterNativeFullscreen);
  video.addEventListener('playing', () => { status.hidden = true; enterNativeFullscreen(); });
  video.addEventListener('error', () => {
    status.textContent = 'The introduction could not load. Refresh the page and try again.';
    status.hidden = false;
  });
  video.addEventListener('webkitbeginfullscreen', () => {
    if (mobile) mobileFullscreen = true;
    nativeFullscreenPending = false;
  });
  video.addEventListener('webkitendfullscreen', () => {
    if (mobile && dialog.open) closeIntro();
  });
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement && shell.contains(document.fullscreenElement) && mobile) mobileFullscreen = true;
    else if (!document.fullscreenElement) {
      unlockOrientation();
      if (mobileFullscreen && dialog.open) closeIntro();
    }
  });
})();
