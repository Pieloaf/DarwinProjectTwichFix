(async () => {
  const path = require("path");
  const fsync = require("fs");
  const mockttp = require("mockttp");
  const { exec } = require("child_process");
  const http = require("http");
  const events = require("node:events");

  const emitter = new events.EventEmitter();

  let twitchTokens;
  let twitchUser;

  // Twitch Constants
  const client_id = "loox1r4lxrnukxnxou9hx90r796h70";
  const twitchScopes = [
    "user_read",
    "viewing_activity_read",
    "user:read:broadcast",
    "user:edit:broadcast",
  ];

  // Twitch URLs
  const twitchLoginURL = new URL("/login", "https://www.twitch.tv");
  const twitchRedirectParams = new URLSearchParams({
    client_id: client_id,
    redirect_uri: "http://localhost",
    response_type: "code",
    scope: twitchScopes.join("+"),
  });

  twitchLoginURL.searchParams.set("client_id", client_id);
  twitchLoginURL.searchParams.set(
    "redirect_params",
    decodeURIComponent(twitchRedirectParams)
  );

  // Scav URLs
  const darwinAuthURL = new URL(
    "/authentication/twitch?",
    "https://pc-live.api.darwinproject.ca"
  );

  const darwinAuthParams = (access_code) => {
    return decodeURIComponent(
      new URLSearchParams([
        ["grantType", "authorization_code"],
        ["authorizationCode", access_code],
        ["scopes", "user_read"],
        ["scopes", "viewing_activity_read"],
        ["scopes", "user:read:broadcast"],
        ["scopes", "user:edit:broadcast"],
      ])
    );
  };

  // Load https cert
  const key = fsync.readFileSync(
    path.join(__dirname, "keys", "selfsigned.key")
  );
  const cert = fsync.readFileSync(
    path.join(__dirname, "keys", "selfsigned.crt")
  );

  const httpServer = http.createServer();
  const proxyServer = mockttp.getLocal({
    https: {
      key: key,
      cert: cert,
    },
  });

  const redirectHandler = (req, res) => {
    let params = new URLSearchParams(req.url);
    let code = params.get("/?code");
    let scope = params.get("scope");

    let resBody = "";
    if (code && scope) {
      getTwitchTokens(code);
      httpServer.close();
      resBody =
        "<script>alert('Success! Click OK to launch Darwin Project to finish the setup');" +
        "window.location='steam://rungameid/544920'</script>";
    }

    res.writeHead(200);
    res.end(resBody);
  };

  httpServer.addListener("request", redirectHandler);

  // when finished with getting tokens
  // close http server and start proxy server
  httpServer.on("close", async () => {
    console.log("Server Closed");
    await startProxy();
  });

  const startProxy = async () => {
    console.log("Starting Proxy...");
    await proxyServer.start();
    exec(`netsh winhttp set proxy 127.0.0.1:${proxyServer.port}`, { shell: "powershell.exe" }, (err, stdout, stderr) => {
      if (err||stderr) {
        console.error("Error starting proxy:", err.message||stderr);
        console.log("Note: This is most likely due to insufficient privileges to set a system wide proxy.");
        console.log("      Run the script from an elevated command prompt.");
        console.log("      Optionally, use the included batch file which will request an elevated prompt before running the script.\n");
        process.exit(1);
      }
      console.log("Proxy Started");
    });
  };

  const stopProxy = async () => {
    console.log("Stopping Proxy...");
    exec("netsh winhttp reset proxy", { shell: "powershell.exe" }, (err, stdout, stderr) => {
      if (err||stderr) {
        console.error("Error stopping proxy: ", err.message||stderr);
        process.exit(1);
      }
      console.log("Proxy Reset");
    });
    proxyServer.stop();
    console.log("Proxy Server Stopped");
    process.exit(0);
  };

  emitter.on("scheduleShutdown", async () => {
    // Wait 2secs before shutting down
    // allows game to receive response before shutdown
    setTimeout(async () => {
      stopProxy();
    }, 2000);
  });

  const getTwitchUser = async () => {
    import("node-fetch").then(async (fetch) => {
      let res = await fetch.default("https://api.twitch.tv/helix/users", {
        method: "GET",
        headers: {
          "Client-ID": client_id,
          Authorization: "Bearer " + twitchTokens.access_token,
        },
      });
      if (res.status !== 200) {
        console.log("[ERROR] Something went wrong getting user...");
        console.error(res.statusText, res.text);
        process.exit(1);
      }
      twitchUser = await res.json();
    });
  };

  const getTwitchTokens = async (access_code) => {
    import("node-fetch").then(async (fetch) => {
      let res = await fetch.default(
        darwinAuthURL + darwinAuthParams(access_code),
        { method: "POST" }
      );
      if (res.status !== 200) {
        console.log("[ERROR] Something went wrong getting access tokens...");
        console.error(res.statusText, res.text);
        process.exit(1);
      }
      twitchTokens = await res.json();

      // update expiration time
      twitchTokens.expires_in = new Date(
        Date.now() + twitchTokens.expires_in
      ).toISOString();
      await getTwitchUser();
    });
  };

  // modify profile to pass twitch tokens to game client
  const modifyProfile = async (res) => {
    let body = JSON.parse(res.body.buffer.toString());

    // ignore if no tokens or profile already connected to twitch
    if (
      !twitchTokens ||
      body.profile.playerStreamingInformation.streamingPlatformTokens.length
    ) {
      return res;
    }

    // set twitch info
    body.profile.playerStreamingInformation.streamingPlatformTokens = [
      {
        accessToken: twitchTokens.access_token,
        refreshToken: twitchTokens.refresh_token,
        platform: 1,
        userId: twitchUser.data[0].id,
        expirationDate: twitchTokens.expires_in,
      },
    ];
    res.body = Buffer.from(JSON.stringify(body));
    res.headers["content-length"] = res.body.length;
    return res;
  };

  // ignore all other requests
  proxyServer.forUnmatchedRequest().thenPassThrough();
  proxyServer.forAnyWebSocket().thenPassThrough();
  proxyServer.forJsonRpcRequest().thenPassThrough();

  // intercept profile request and modify response
  proxyServer
    .forGet(/(https:\/\/pc-live.api.darwinproject.ca\/profile\/[0-9]*)$/)
    .always()
    .thenPassThrough({
      beforeResponse: modifyProfile,
    });

  proxyServer
    .forPut(
      /(https\:\/\/pc-live.api.darwinproject.ca\/profile\/[0-9]*\/presence\/Shutdown)$/
    )
    .always()
    .thenPassThrough({
      beforeResponse: () => {
        emitter.emit("scheduleShutdown");
      },
    });

  // for any request to proxy endpoint respond ok
  // required to avoid recurive requests to proxy
  proxyServer
    .forAnyRequest()
    .forHostname("localhost")
    .forPort("8000")
    .thenReply(200);

  // open login page
  exec(`start "" "${twitchLoginURL}"`);

  console.log("Starting Server...");
  httpServer.listen(80);
  console.log("Server Started");
})();
