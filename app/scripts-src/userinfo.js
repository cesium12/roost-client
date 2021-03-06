"use strict";

// Minimum amount of time between updates.
var USER_INFO_UPDATE_THROTTLE = timespan.seconds(10);

function UserInfoConflict() {
}

function UserInfo(api) {
  RoostEventTarget.call(this);

  this.api_ = api;

  this.base_ = null;
  this.baseVersion_ = -1;

  this.local_ = null;
  this.pending_ = null;

  this.throttler_ =
    new Throttler(this.doUpdate_.bind(this), USER_INFO_UPDATE_THROTTLE);

  this.ready_ = Q.defer();

  // TODO(davidben): If the initial load fails, we never get the
  // ready. Retry? Maybe just query on login and save the state.
  this.loadInfo_().done();
}
UserInfo.prototype = Object.create(RoostEventTarget.prototype);

UserInfo.prototype.handleNewInfo_ = function(info, version) {
  try {
    this.base_ = JSON.parse(info);
  } catch (err) {
    if (window.console && console.log)
      console.log("Error parsing user info", err);
    this.base_ = null;
  }
  this.baseVersion_ = version;
  if (Q.isPending(this.ready_.promise))
    this.ready_.resolve();
  this.dispatchEvent({type: "change"});
};

UserInfo.prototype.loadInfo_ = function() {
  return this.api_.get("/v1/info").then(function(ret) {
    this.handleNewInfo_(ret.info, ret.version);
  }.bind(this));
};

UserInfo.prototype.ready = function() {
  return this.ready_.promise;
};

UserInfo.prototype.get = function(key) {
  if (this.baseVersion_ < 0)
    throw "User info not loaded!";

  if (this.local_ && key in this.local_)
    return this.local_[key];
  if (this.pending_ && key in this.pending_)
    return this.pending_[key];
  return (typeof this.base_ === "object" && this.base_) ?
    this.base_[key] : undefined;
};

UserInfo.prototype.set = function(key, value) {
  if (this.baseVersion_ < 0)
    throw "User info not loaded!";

  if (!this.local_)
    this.local_ = {};
  this.local_[key] = value;
  this.dispatchEvent({type: "change"});
  this.throttler_.request();
};

UserInfo.prototype.mergeLocalAndPending_ = function() {
  for (var key in this.local_) {
    if (this.local_.hasOwnProperty(key))
      this.pending_[key] = this.local_[key];
  }
  this.local_ = this.pending_;
  this.pending_ = null;
};

UserInfo.prototype.doUpdate_ = function() {
  this.pending_ = this.local_;
  this.local_ = null;

  // Merge this into the current base.
  var newInfo = {};
  for (var key in this.base_) {
    if (this.base_.hasOwnProperty(key))
      newInfo[key] = this.base_[key];
  }
  for (var key in this.pending_) {
    if (this.pending_.hasOwnProperty(key))
      newInfo[key] = this.pending_[key];
  }

  // Fire off a test-and-set.
  var newVersion = this.baseVersion_ + 1;
  var newInfoStr = JSON.stringify(newInfo);
  return this.api_.post("/v1/info", {
    expectedVersion: this.baseVersion_,
    info: newInfoStr
  }).then(function(ret) {
    if (ret.updated) {
      // Success!
      this.handleNewInfo_(newInfoStr, newVersion);
      this.pending_ = null;
    } else {
      // Failure. Retry.
      this.handleNewInfo_(ret.info, ret.version);
      this.mergeLocalAndPending_();
      // Just loop like this. It should be fine.
      return this.doUpdate_();
    }
  }.bind(this), function(err) {
    // HTTP error.
    this.mergeLocalAndPending_();
    // TODO(davidben): The throttler is bad at reporting errors! Make
    // sure this goes somewhere.
    throw err;
  }.bind(this));
    
};
