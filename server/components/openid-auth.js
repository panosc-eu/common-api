
const { Issuer } = require('openid-client');

module.exports = registerComponent;


async function registerComponent (app, options) {

  try {
    // Create OIDC Client
    const issuer = await Issuer.discover(options.url);
    const client = new issuer.Client({
      client_id: options.clientId
    });

    app.remotes().phases
    .addBefore('invoke', 'openid-auth')
    .use(async function(ctx, next) {
      if (!ctx.args.options) {
        return next();
      }

      try {
        // Get access token from header
        const token = ctx.req.headers.access_token;

        if (token) {
          // Authenticate the user
          const userInfo = await client.userinfo(token);

          // Get userId from claims (required keycloak to be configured correctly)
          const userId = userInfo[options.userIdClaimKey];

          // Add user id to context
          const user = {
            id: `${userId}`,
            username: userInfo['preferred_username']
          };
          ctx.args.options.user = user;

          console.log(`${new Date().toISOString()}: User ${user.username} (${user.id}) requesting ${ctx.req.baseUrl}`);

        } else {
          console.log(`${new Date().toISOString()}: User <anonymous> requesting ${ctx.req.baseUrl}`);
        }

      } catch (error) {
        console.error(`Authentication error: ${error.message}`);
      }

      next();
    });

  } catch (error) {
    console.error(`Could not create client for OpenID Connect provider at ${options.url} : ${error.message}`);
  }

}

