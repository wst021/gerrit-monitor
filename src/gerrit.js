// Copyright 2019 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as browser from './browser.js';
import * as config from './config.js';
import * as utils from './utils.js';

// A single message in a CL.
export class Message {
  constructor(json) {
    this.json_ = json;
  }

  // Returns whether the message should be ignored. Messages should be ignored
  // if they have a tag starting by "autogenerated:" except for "newPatchSet"
  // and "newWipPatchSet" messages.
  shouldBeIgnored() {
    if (!this.json_.tag_)
      return false;

    var tag = this.json_.tag_;
    if (!tag.startsWith("autogenerated:"))
      return false;

    if (tag == "autogenerated:gerrit:newPatchSet")
      return false;

    if (tag == "autogenerated:gerrit:newWipPatchSet")
      return false;

    return true;
  }

  // Returns whether the user is the author of this message.
  isAuthoredBy(user) {
    return this.json_.real_author._account_id == user._account_id;
  }

  // Returns the time of the message.
  getTime() {
    // Gerrit returns times in the format "YYYY-MM-DD HH:MM:SS.000000000", in
    // UTC.
    return new Date(this.json_.date + " UTC");
  }

  static wrap(json) {
    return new Message(json);
  }
}

// A single CL in a search result.
export class Changelist {
  constructor(host, json) {
    this.host_ = host;
    this.json_ = json;
    this.description_ = null;
    this.reviewers_ = null;
    this.messages_ = null;
    this.current_revision_ = null;
  }

  // Returns the underlying json data.
  toJSON() {
    return this.json_;
  }

  // Returns whether the user is the owner of this CL.
  isOwner(user) {
    return this.json_.owner._account_id === user._account_id;
  }

  // Returns whether the CL is submittable.
  isSubmittable() {
    return this.json_.submittable;
  }

  // Returns whether the CL has unresolved comments.
  hasUnresolvedComments() {
    return this.json_.unresolved_comment_count !== 0;
  }

  // Returns whether the CL is labeled 'work in progress'.
  isWorkInProgress() {
    return this.json_.work_in_progress === true;
  }

  // Returns the number of lines changed by this CL.
  getDeltaSize() {
    return this.json_.insertions + this.json_.deletions;
  }

  // Retuns the size category for this CL.
  getSizeCategory() {
    var deltaSize = this.getDeltaSize();
    if (deltaSize < 30) {
      return Changelist.SMALL;
    }
    if (deltaSize < 300) {
      return Changelist.MEDIUM;
    }
    return Changelist.LARGE;
  }

  // Returns all the reviewers, including owner for a CL that match a filter.
  filterReviewers(filter) {
    var codeReviewLabel = this.json_.labels['Code-Review'];
    return ((codeReviewLabel && codeReviewLabel.all) || [])
        .filter(function(reviewer) {
            return !!reviewer._account_id && filter(reviewer);
      });
  }

  // Returns whether the user has reviewed this CL.
  hasReviewed(user) {
    return this.filterReviewers(function(reviewer) {
      return reviewer.value > 0 && reviewer._account_id === user._account_id;
    }).length !== 0;
  }

  // Returns whether the message is stale (i.e. the last message on it
  // was posted more than 24h ago).
  isStale() {
    var allMessages = this.getMessages();
    var filteredMessages = allMessages.filter(function(message) {
      return !message.shouldBeIgnored();
    });

    var lastMessage = filteredMessages[filteredMessages.length - 1];
    if (!lastMessage) {
      // If all messages are auto-generated, then look at the date of the
      // last auto-generated message to decide whether the CL is stale or
      // not.
      lastMessage = allMessages[allMessages.length - 1];
      if (!lastMessage)
        return true;
    }

    var timeSinceLastMessageInMilliseconds =
        new Date().getTime() - lastMessage.getTime();
    return timeSinceLastMessageInMilliseconds > 1000 * 3600 * 24;
  }

  // Returns whether the author commented more recently than user.
  authorCommentedAfterUser(user) {
    var owner = this.json_.owner;
    var filteredMessages = this.getMessages().filter(function(message) {
      if (message.shouldBeIgnored())
        return false;
      return message.isAuthoredBy(user) || message.isAuthoredBy(owner);
    });

    var lastMessage = filteredMessages[filteredMessages.length - 1];
    return !lastMessage || lastMessage.isAuthoredBy(owner);
  }

  // Returns the type of attention this CL needs from the given user.
  getCategory(user) {
    if (this.isOwner(user)) {
      if (this.isSubmittable() && !this.hasUnresolvedComments())
        return Changelist.READY_TO_SUBMIT;

      if (this.isWorkInProgress())
        return Changelist.WIP;

      if (this.getReviewers().length == 0)
        return Changelist.NO_REVIEWERS;

      if (this.hasUnresolvedComments())
        return Changelist.OUTGOING_NEEDS_ATTENTION;

      if (this.isStale())
        return Changelist.STALE;

      return Changelist.NONE;
    }

    if (!this.hasReviewed(user)) {
      // Check if the latest CL revision is explicitly marked as reviewed or
      // unreviewed.
      var current_rev_number = this.getCurrentRevision().getNumber();
      var latest_tagged_rev_number = -1;
      var latest_tag_is_reviewed = null;
      for (const star_label of this.getStars()) {
        var parts = star_label.split('/');
        if (parts.length != 2)
          continue;
        if (parts[0] != "reviewed" && parts[0] != "unreviewed")
          continue;
        var tagged_rev_number = parseInt(parts[1]);
        if (tagged_rev_number <= latest_tagged_rev_number)
          continue;
        latest_tagged_rev_number = tagged_rev_number;
        latest_tag_is_reviewed = parts[0] == "reviewed";
      }
      if (latest_tagged_rev_number == current_rev_number) {
        if (latest_tag_is_reviewed)
          return Changelist.NONE;
        else
          return Changelist.INCOMING_NEEDS_ATTENTION;
      }

      // The heuristic used to determine how to categorize the message is weak
      // because it is not possible to retrieve all the comments using the API
      // of Gerrit. So, ignore the has_unresolved_comments if the user left a
      // comment message more recently than the owner.
      if (this.authorCommentedAfterUser(user))
        return Changelist.INCOMING_NEEDS_ATTENTION;

        return Changelist.NONE;
      }

    return Changelist.NONE;
  }

  // Returns an Url to open Gerrit at this CL.
  getGerritUrl() {
    return this.host_ + '/c/' + this.json_.project + '/+/' + this.json_._number;
  }

  // Returns the list of reviewers for this CL.
  getReviewers() {
    if (this.reviewers_ === null) {
      var owner = this.json_.owner;
      this.reviewers_ = this.filterReviewers(function(reviewer) {
        return reviewer._account_id !== owner._account_id;
      });
    }
    return this.reviewers_;
  }

  // Returns the list of messages for this CL.
  getMessages() {
    if (this.messages_ === null) {
      this.messages_ = this.json_.messages.map(Message.wrap);
    }
    return this.messages_;
  }

  // Returns the author of this CL.
  //
  // Requires detailed information (see fetchReviews).
  getAuthor() {
    return this.json_.owner.name;
  }

  // Returns the list of stars labels of this CL or an empty list if doesn't
  // contain that field.
  getStars() {
    if ('stars' in this.json_)
      return this.json_.stars;
    return [];
  }

  // Returns the current revision (aka patchset) of this CL.
  getCurrentRevision() {
    if (this.current_revision_ === null) {
      this.current_revision_ = new Revision(
          this.json_.revisions[this.json_.current_revision]);
    }
    return this.current_revision_;
  }

  // Returns the CL description.
  //
  // Requires detailed information (see fetchReviews).
  getDescription() {
    if (this.description_ === null) {
      this.description_ = new Description(
          this.getCurrentRevision().toJSON().commit.message);
    }
    return this.description_;
  }

  static wrap(host, json) {
    return new Changelist(host, json);
  }
}

// The CL size categories.
Changelist.SMALL = 'small';
Changelist.MEDIUM = 'medium';
Changelist.LARGE = 'large';

// The CL does not require any attention.
Changelist.NONE = 'none';

// The CL is stale (no recent activity).
Changelist.STALE = 'stale';

// The CL has not been sent for review yet.
Changelist.NO_REVIEWERS = 'no_reviewers';

// The CL is labeled 'work in progress'.
Changelist.WIP = 'work_in_progress';

// Someone else is waiting for this user to review the CL.
Changelist.INCOMING_NEEDS_ATTENTION = 'incoming_needs_attention';

// The CL is authored by this user and requires this user's attention.
Changelist.OUTGOING_NEEDS_ATTENTION = 'outgoign_needs_attention';

// This CL is full approved, the author can submit.
Changelist.READY_TO_SUBMIT = 'ready_to_submit';

// Wrapper around a changelist's revision (aka patchset).
export class Revision {
  constructor(json) {
    this.json_ = json;
  }

  // Returns the underlying json data.
  toJSON() {
    return this.json_;
  }

  // Returns index of this revision.
  getNumber() {
    return this.json_._number;
  }
}

// Wrapper around a changelist description.
export class Description {
  constructor(text) {
    this.text_ = text;
    this.message_ = null;
    this.attibutes_ = null;
  }

  // Returns the raw text of the description.
  getText() {
    return this.text_;
  }

  // Returns just the message, not the attributes at the bottom.
  getMessage() {
    this.ensureParsed();
    return this.message_;
  }

  // Returns the list of attributes.
  getAttributeList() {
    this.ensureParsed();
    return this.attributes_;
  }

  // Ensure that the description is parsed.
  ensureParsed() {
    if (this.message_ === null) {
      var parsed = Description.parse(this.text_);
      this.message_ = parsed[0];
      this.attributes_ = parsed[1];
    }
  }

  // Parse the CL description.
  static parse(text) {
    var ATTRIBUTE_RE = /^\s*([-A-Za-z]+)[=:](.*)$/;
    var lines = text.split('\n');
    var cutoff = lines.length - 1;
    // Peel off the trailing empty lines.
    while (cutoff >= 1 && lines[cutoff] === '')
      cutoff--;
    // Peel off the attributes.
    var attributes = [];
    while (cutoff >= 1) {
      if (lines[cutoff] !== '') {
        var match = ATTRIBUTE_RE.exec(lines[cutoff]);
        if (!match)
          break;

        attributes.push([match[1], match[2]]);
      }
      cutoff--;
    }
    // Peel off any empty line separating the attributes and the message.
    while (cutoff >= 1 && lines[cutoff] === '')
      cutoff--;
    // Set the description attributes.
    return [lines.splice(0, cutoff + 1).join('\n'), attributes.reverse()];
  }
}

// The result of a search query.
export class SearchResult {
  constructor(host, user, data) {
    this.host_ = host;
    this.user_ = user;
    this.data_ = data;
  }

  // Returns data required to recreate the SearchResult.
  toJSON() {
    return {host: this.host_, user: this.user_, data: this.data_};
  }

  // Returns a map from a type of attention to the CLs that needs that
  // attention from the user.
  getCategoryMap() {
    var result = new utils.Map();
    var user = this.getAccount();
    this.data_.forEach(function(cl) {
      var attention = cl.getCategory(user);
      if (!result.has(attention)) {
        result.put(attention, []);
      }
      var cls = result.get(attention);
      if (!cls.includes(cl)) {
        cls.push(cl);
      }
    });
    return result;
  }

  // Returns the user account for this search result.
  getAccount() {
    return this.user_;
  }

  static wrap(host, user, data) {
    return new SearchResult(
        host,
        user,
        data.map(function(json) { return Changelist.wrap(host, json); }));
  }
}

// The result of multiple search queries.
export class SearchResults {
  constructor(results) {
    this.results_ = results;
  }

  // Returns the data required to recreate the SearchResult.
  toJSON() {
    return this.results_;
  }

  // Returns a map from a type of attention to the CLs that need that
  // attention from the user.
  getCategoryMap() {
    var categories = new utils.Map();
    this.results_.forEach(function(result) {
      result.getCategoryMap().forEach(function(attention, cls) {
        if (!categories.has(attention)) {
          categories.put(attention, []);
        }
        categories.put(attention, categories.get(attention).concat(cls));
      });
    });
    return categories;
  }
}

// Parse a JSON reply from Gerrit and return a Promise.
//
// All Gerrit JSON replies start with )]}'\n. The function validates this
// and return a rejected Promise if this is not the case.
function parseJSON(reply) {
  var header = reply.substring(0, 5);
  if (header === ")]}'\n") {
    return Promise.resolve(JSON.parse(reply.substring(5)));
  }

  return Promise.reject(new Error(
      'Unexpected reply from Gerrit server: ' + header + '...'));
};

// Sends a request using the Gerrit JSON API.
//
// See https://gerrit-review.googlesource.com/Documentation/rest-api.html
// for the documentation of the gerrit API.
//
// Returns a promise containing the JSON reply or an error.
function sendRequest(host, path, params) {
  let tryFetch = function() {
    return browser.fetchUrl(host + path, params, {
      'pragma': 'no-cache',
      'cache-control': 'no-cache, must-revalidate',
    })
  };

  return tryFetch()
    .catch(function(error) {
      // Just pass through non-login errors.
      if (!(error instanceof browser.FetchError) || !error.is_login_error) {
        return Promise.reject(error);
      }
      // Some Gerrit instances attempt to redirect the user via an
      // authentication server every few hours to refresh some cookies. Such
      // redirects will fail, due to Chrome's CORS restrictions.
      //
      // In these cases, we can attempt to send an opaque request (with "mode:
      // no-cors") that _will_ successfully redirect via the authentication
      // server and refresh any cookies, and then send the original request
      // again.
      //
      // This won't solve cases where a user needs to type in a password, but
      // will allow GerritMonitor to continue working if the problem is simply
      // an authentication cookie refresh was required.
      return fetch(host, {
          mode: 'no-cors',
          credentials: 'include',
        })
        .then(function(_) {
          // Try original request again.
          return tryFetch();
        })
        .catch(function(_) {
          // If we failed, return the original error we got.
          return Promise.reject(error);
        });
    });
};

// Returns a promise with the information of the user account.
export function fetchAccount(host) {
  return sendRequest(host, '/accounts/self')
    .then(function(response) {
      if (response.substring(0, 5) != ")]}'\n") {
        return Promise.reject(new Error(
            'Cannot fetch account.' +
            config.LOGIN_PROMPT));
      }
      return Promise.resolve(response);
    }).then(parseJSON);
};

// Returns a promise with all reviews requiring attention.
export function fetchReviews(host, account, detailed) {
  var params = [];
  var userid = account._account_id;
  params.push(['q', 'status:open owner:' + userid]);
  params.push(['q', 'status:open -star:ignore reviewer:' + userid + ' -owner:' + userid]);
  params.push(['o', 'CURRENT_REVISION']);
  params.push(['o', 'DETAILED_LABELS']);
  params.push(['o', 'MESSAGES']);
  params.push(['o', 'REVIEWED']);
  params.push(['o', 'SUBMITTABLE']);
  if (detailed) {
    params.push(['o', 'CURRENT_COMMIT']);
    params.push(['o', 'DETAILED_ACCOUNTS']);
  }
  return sendRequest(host, '/changes/', params)
    .then(parseJSON)
    .then(function(results) {
    return Promise.resolve(SearchResult.wrap(
        host, account, [].concat.apply([], results)));
  });
};

// Returns a promise with a list of all host that are configured
// including those that have no permissions granted.
export function fetchAllInstances() {
  return Promise.all([
      browser.loadOptions(),
      browser.getAllowedOrigins(),
    ]).then(function(values) {
      var instances = [];
      var origins = values[1];
      values[0].instances.forEach(function(instance) {
        // Version of the extension prior to 0.7.7 allowed instance.host
        // to contains a trailing '/' which caused issue as some gerrit
        // instances fails when there are '//' in the path. Fix the host
        // by dropping the trailing '/'.

        var match = config.ORIGIN_REGEXP.exec(instance.host);
        if (match !== null) {
          instances.push({
            host: match[0],
            name: instance.name,
            enabled: instance.enabled && origins.includes(match[1] + "/*"),
          });
        }
      });
      return Promise.resolve(instances);
    });
};

// Returns a promise with a list of all host that the extension has
// been granted permissions to access.
export function fetchAllowedInstances() {
  return fetchAllInstances().then(function(instances) {
    return Promise.resolve(instances.filter(function(instance) {
      return instance.enabled;
    }));
  });
};
