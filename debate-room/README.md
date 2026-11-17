# The Debate Room: free local AI

The public timer is at https://jasonkessler.github.io/debate-room/.
Local mode adds speaker-attributed recording, Whisper transcription, and an Ollama argument notebook. It uses no paid API, API key, or ChatGPT subscription. Processing runs on the computer hosting the debate; each user needs their own local setup.

## Start on an Apple Silicon Mac

1. If `ollama list` already works, skip installation. Otherwise install and open [Ollama](https://ollama.com/download). Install a **local** text model that fits your Mac, for example `ollama pull llama3.2:3b`. Existing installed local models are detected automatically; the smallest is selected initially. Cloud models are excluded.
2. With [Homebrew](https://brew.sh), install the free dependencies: `brew install uv ffmpeg`.
3. Download [the local setup ZIP](https://jasonkessler.github.io/debate-room/debate-room-local.zip) and unzip it.
4. In Terminal, type `bash `, drag `Start Debate Room.command` into the window to insert its full path, then press Return. You can also run `bash "/full/path/to/Start Debate Room.command"`.
5. Keep the launcher window and Ollama open. The launcher opens **http://127.0.0.1:18766/**. Use port 18766 when transferring a round from the public page. If you used an earlier version at port 8766, that address has separate browser storage; export its old notes before moving.
6. Set up a debate and draw roles. In **Debate notebook**, enable **local recording & notes**. Tell participants you are recording, then grant microphone access when prompted.

The launcher creates a Python 3.12 environment at `~/.local/share/debate-room/venv`. First use downloads free software and Whisper weights (`mlx-community/whisper-large-v3-turbo`, approximately 1.6 GB). Existing cached weights are reused. Model downloads require internet access; the recordings and transcripts are never sent to a paid or hosted AI service. Local inference uses memory, storage, electricity, and time.

This version uses MLX and requires an Apple Silicon Mac. It does not yet include a Windows, Linux, Intel Mac, phone-only, or fully in-browser inference backend. Use one computer and microphone to host an in-person debate. It does not collect audio from other participants' devices.

## During the debate

- With **Record with the speech timer** checked, starting a speech/answer timer begins recording the assigned speaker. Pause, reset, previous/next turn, and timer expiry finalize the recording. Deliberation is not recorded automatically.
- For question turns, click **Record question** to capture the moderator or questioner. Starting the answer timer finalizes that question and begins a separate recording attributed to the debater. Recording and transcription do not identify voices; overlapping speech or interruptions require correcting the participant afterward.
- **Record current speaker** and **Stop & take notes** also work independently of the timer. Audio uploads are attributed to the current debater. For an uploaded question, correct the participant afterward.
- Processing happens after each recording and runs in a queue. The next turn can proceed while Whisper and Ollama finish. The first turn can be slower while models load. A quiet room and one speaker at a time help accuracy.
- Each notebook entry contains a summary, points classified as claims/reasons/evidence/rebuttals/questions/concessions, and supporting transcript quotes. Points with quotes that do not match the transcript are omitted. This checks the quote, not the correctness of the model's interpretation.
- Expand **Transcript, attribution & recording** to play/download the audio, correct the transcript or speaker, and extract points again. Typed transcripts can also be saved and summarized locally.
- Download notes as Markdown or JSON. Audio is downloaded individually. Transcription segments and times are included in JSON exports; they refer to each clip, not a synchronized whole-debate recording.
- Judges make the decision; AI notes do not score the debate or declare a winner.

## Saving, privacy, and moving between pages

Round settings, transcripts, and notes are saved to browser local storage. Audio blobs are saved to IndexedDB in that browser. These are not cloud backups. Export important notes and recordings before clearing browser data, using a different browser, or resetting the debate. Returning to setup/redrawing roles resets the current round and its visible notebook. Audio blobs are retained in the browser database until site data is cleared.

The public GitHub page and the local page have separate browser storage. **Open local AI mode** transfers the current setup, roles, and existing text notebook through a URL fragment to the local page and pauses any running timer. URL fragments are not sent to the local server. Existing audio stays with its original browser origin. The local page removes the fragment after import. Keep the original page if you need to export its audio.

Only click **Enable local recording & notes** when you want capture available. Microphone access is requested when a recording starts. There is a visible recording indicator on the timer, and microphone tracks stop when the recording ends. After a refresh, recording is disabled until you enable it again. A recording still in progress can be lost if you forcibly close the tab; completed clips and saved transcripts can be recovered. Interrupted processing can be retried from its entry.

The Python service binds only to `127.0.0.1`, accepts only its own local browser origin, and does not expose a network-wide endpoint or change Ollama's access settings. Internet access may still be needed for initial software/model downloads. No analytics or hosted inference endpoints are included in this local mode.

## Troubleshooting

- **Could not connect:** launch the companion, open `http://127.0.0.1:18766/`, and click **Reconnect local AI**. The public HTTPS page intentionally does not call a localhost API directly.
- **Ollama missing/no models:** open Ollama and install a local model; reconnect. Avoid a model larger than your available memory. Select a smaller installed model in the notebook if needed.
- **Transcription failure:** check FFmpeg and the launcher window. Try uploading WAV/MP3/M4A/WebM under 40 MB. Recordings are limited to one hour. Retry from the saved entry.
- **No microphone/permission denied:** allow microphone access in the browser's site settings. You can upload audio or type a transcript instead.
- **Incorrect transcription or notes:** edit the transcript/participant and regenerate the points. Speech recognition can omit or invent words; quoted support does not verify a speaker's factual claims.
- **Browser storage unavailable/full:** download immediately. Browser-private windows or storage limits can prevent local saving.
- **Port in use:** an existing companion may already be running. Open its local URL, or stop it with Control-C before restarting.

For development, run `python3 -m unittest discover -s tests` and `node tests/recording.test.cjs` from this folder. To launch directly with an existing environment: `~/.local/share/debate-room/venv/bin/python local_service.py`.
