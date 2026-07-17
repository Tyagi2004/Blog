const User = require("../models/User");

// Loads the logged-in user (if any) onto req.user + res.locals.currentUser
// so every EJS view can access `currentUser` without repeating lookups.
async function loadUser(req, res, next) {
  if (req.session && req.session.userId) {
    try {
      const user = await User.findById(req.session.userId);
      if (user) {
        req.user = user;
        res.locals.currentUser = user;
        return next();
      }
    } catch (err) {
      // ignore bad/stale session id
    }
  }
  req.user = null;
  res.locals.currentUser = null;
  next();
}

// Blocks access unless a valid user is logged in.
function requireAuth(req, res, next) {
  if (!req.user) {
    req.session.returnTo = req.originalUrl;
    req.session.errorMsg = "Please log in to continue.";
    return res.redirect("/login");
  }
  next();
}

module.exports = { loadUser, requireAuth };
