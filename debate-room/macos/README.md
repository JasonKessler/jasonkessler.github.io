# Debate Room for Mac

Open **Debate Room.app** from Finder. The app opens a macOS window and starts the local service automatically. Its debate interface runs in WebKit. Debates, participants, transcripts, notes, and recordings are cleared when the app closes. Audio capture preferences can carry over to the next launch.

The build targets Apple Silicon and macOS 14 or later. Local AI uses FFmpeg, Whisper, and an installed Ollama model. If you already use the browser companion, the Mac app reuses the same Python environment and model downloads. For a new machine, install Ollama, pull a local model, and install `uv` and `ffmpeg` with Homebrew. The first launch can set up the Python environment and install Whisper. Whisper downloads its model weights on first use if needed.

Enable recording in the notebook and grant microphone access when macOS asks. The app starts transcription locally when a turn finishes.

## AI participants

Enter every participant under **Participants**. Use the selector beside each name to assign their role or leave it random. Open **AI participants** and check the names you want to play as AI. Give each one a personality and debate style and select an installed Ollama model. For example, “skeptical and succinct, challenges causal claims, concedes when shown contrary evidence.”

On an AI turn, draft a speech, question, or answer. Review the text and select **Use this turn** to add it to the notebook. Accepted turns can be read aloud through the Mac app. A person controls the timer and verdict. For an AI answer to a human question, record the question or type it into the answer panel. AI players use earlier notebook entries as context.

An AI moderator can read the motion, announce the next speaker and time limit, and ask their allotted questions. AI questioners draft questions based on their debate style and earlier turns. During **Deliberation**, the human panel decides the result. If there are no human panel members, the host records the decision.

The notebook shows one entry per visited agenda turn. A Q&A entry contains both speakers, and resumed recordings stay within their original turn.

AI drafts wait for earlier recordings queued for processing and receive the notebook’s speaker labels, turn numbers, transcript excerpts, and extracted points. Rebuttals require remarks from the other side. Questions target the addressee’s earlier claims when available. Accept a draft to add it to the same agenda entry.

When both the questioner and debater are AI, draft the question and choose **Use question & draft AI answer**. The answer uses that exact question, and the notebook stores the accepted question and answer under their respective speakers.

During **Deliberation**, select **Start AI deliberation** to ask the AI moderator and questioners for independent ballots. When the panel has no AI members, a neutral AI judge can review the round. Each ballot uses excerpts from the notebook for both sides. The app checks any quotes against those excerpts. A strict majority of non-abstaining ballots yields a recommendation. If the record changes, rerun deliberation. **Record AI verdict** ends deliberation and records the recommendation. Viewers see the recorded result when the host publishes it.

For a fictional character with racist beliefs, describe how the bias appears in their reasoning, such as applying a stricter test of belonging to outsiders. The model can portray these double standards for other participants to challenge. The app instructs it to avoid slurs, racial hierarchy claims, and advocacy of discrimination. Review the draft before accepting it, especially when automatic notebook sharing is enabled.

## Share on the local network

1. Create a round and choose **Sharing → Share Debate**. Select **Points only** or **Points and transcript**. Only the second option includes transcript text and supporting quotes. Saved audio stays on the host Mac.
2. Start sharing and copy the invite. Send it to viewers on the same network. Invite links expire after one hour for new devices. Viewers choose **Sharing → Join Debate**, enter a name, and paste the invite.
3. Select a waiting viewer and click **Approve**. Click **Publish Notebook** to send the current version, or enable **Publish automatically** for updates as turns are processed. The host can pause updates or remove a connected viewer at any time.
4. Viewers read and scroll in their own window. New viewers receive the most recently published notebook after approval. A viewer who briefly disconnects can resume without a fresh approval while the window and host session stay open. Closing the host's sharing window ends the session.

Hosting requires macOS 15 or later. Viewers can join without installing Whisper or Ollama. Allow **Local Network** access if macOS asks. Guest networks that isolate devices can prevent a connection. Each session uses a fresh TLS identity. The invite pins the host certificate and carries a random invite secret. The app sends notes over separate encrypted peer connections and does not advertise the proposition or notebook in Bonjour.

## Invite people using a browser

1. On the Mac running Debate Room 2.2 or later, start **Sharing → Share Debate**. Select **Points and transcript** and **Publish automatically** if guests should see new turns as they are processed.
2. Click **Copy Browser Guest Link** and send the link to guests. Open the video call on the host Mac if you want guests to speak or see the call.
3. Guests open the full link in a browser, enter the exact name from the debate setup, and request access. Approve them from the host’s sharing window. They can read and scroll through the notebook immediately after it is published.
4. Guests choose whether to share a microphone or camera and select **Join call**. The same four-person call limit applies across Mac apps and browsers. Additional guests can read the notebook. For remote transcription, enable **Record audio from the video call** on the host Mac.

The host uses the same Cloudflare tunnel setup as internet invites. The guest link expires for new visitors after one hour or when sharing ends. The link carries the room’s encryption key in its URL fragment, so send it privately. GitHub Pages serves the guest page. The tunnel carries encrypted notebook and signaling messages, and WebRTC carries the call between participants. Whisper and Ollama run on the host Mac.

## Share a live transcript over the internet

Use Debate Room 1.7 or later on every Mac. Only the host sets up the tunnel. Viewers need the Mac app and internet access.

1. On the host Mac, start **Share Debate**, choose **Points and transcript**, and enable **Publish automatically** if you want live updates.
2. Click **Copy Internet Invite** and wait for the invite to be copied. Send that invite to viewers. They paste it into **Sharing → Join Debate** and wait for your approval.
3. Keep the host app and sharing window open. When sharing ends, the temporary Cloudflare address closes. Start a new session to refresh the address and invite.

The app uses a [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) as the internet carrier. Debate Room's TLS connection stays encrypted from the viewer app to the host app. The tunnel carries only the encrypted sharing connection. Quick Tunnels are intended for testing and have no uptime guarantee.

For a new host Mac, install the tunnel tools once after the Debate Room Python environment has initialized:

```sh
brew install cloudflared
"$HOME/.local/share/debate-room/venv/bin/python" -m pip install websockets==15.0.1
```

If that environment uses uv and lacks pip, run `uv pip install --python "$HOME/.local/share/debate-room/venv/bin/python" websockets==15.0.1`.

## Share a live transcript across locations

Use Debate Room 1.6 or later on every Mac. Connect each Mac to a private network such as Tailscale. Give viewers access to the host Mac through your tailnet or [Tailscale device sharing](https://tailscale.com/docs/features/sharing). Leave the VPN connected during the debate.

1. On the host Mac, choose **Sharing → Share Debate**, select **Points and transcript**, and click **Start Sharing**. Enable **Publish automatically** for live updates.
2. Click **Copy VPN Invite**. Enter your Mac’s Tailscale IP address or full MagicDNS name. Debate Room includes the current TCP port shown in the dialog. If you manage custom access rules, allow that port from the viewers’ devices.
3. Send the resulting Debate Room invite to the viewers. They select **Sharing → Join Debate**, paste it, and wait for your approval. Resume or publish after reconnecting as needed. A new sharing session needs a fresh invite.

The remote invite carries the host address, the session key fingerprint, and the invite secret. All viewers receive the host's published text with their own scroll position. The host can record and transcribe remote turns directly from the built-in call.

## Try a four-person video call

Participants can use Debate Room 2.0 or later or join with a browser guest link. Start a shared debate and send the local or internet invite. On the host Mac, click **Open video call** so approved viewers can open it too. Each person chooses **Camera** and **Microphone**, then **Join call**. Clear both boxes to listen without sharing your own feeds. Closing the video window leaves the call. Stop and save any recording before closing the window or ending sharing.

The sharing connection carries WebRTC setup messages. Each participant sends separate camera and microphone streams directly to the others when possible. Four people total can join the video call. Additional approved viewers can follow the notebook. The app limits camera resolution and video upload bitrate for a small room.

If peers on a restricted network cannot connect, enter the URL, username, and password for a TURN service under **TURN relay settings** before joining. You can leave and rejoin to change relay settings. Each Mac that needs relay service should have usable TURN credentials. The app does not supply a relay account. The debate timer and notebook stay in their own windows.

## Transcribe a call on the host Mac

1. Use Debate Room 2.1 or later on the Mac hosting and timing the debate. That Mac runs the local Whisper and Ollama services. Guests use **Join Debate** with the exact names in the debate setup. They can turn off their camera and keep their microphone on.
2. The host joins the call too. In the notebook, enable recording and select **Record audio from the video call**. Under **Who speaks on this Mac?**, select the host’s participant name, or choose **Nobody (listen-only)**. Let callers know before recording.
3. Start the timer to record the current speaker’s microphone track. Use **Record question** for a human questioner, then start the timer to record the answer. Recording stops when the timer expires, pauses, or advances, or when you click **Stop & take notes**. If a caller leaves during a turn, stop recording to save the partial clip.
4. Whisper transcribes the clip and Ollama extracts the points on the host Mac. Other participants can follow the transcript and points when the host chooses **Points and transcript** and publishes the notebook. Saved recordings are available on the host Mac.

If the app cannot start recording, check that the speaker’s call is connected and their microphone is on. When a turn has no clear speech, play its saved audio to check what reached the host. For a debate in one room, leave **Record audio from the video call** off to use the host’s room microphone.

Release shared Debate Room changes in both the Mac app and the website. Verify the installed app and the live site before calling a shared update complete.

To build on your Mac, install the Xcode command line tools and run `bash macos/build-app.sh /path/to/output` from the Debate Room source folder. The script creates an ad hoc signed app and a ZIP. A copy distributed to other Macs may be blocked by Gatekeeper. Distribution with standard Gatekeeper approval requires Developer ID signing and notarization.
