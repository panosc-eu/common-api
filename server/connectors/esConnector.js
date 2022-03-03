'use strict';

let util = require('util');
let fs = require('fs');
let path = require('path');
let _ = require('lodash');
let Promise = require('bluebird');
let hash = require('object-hash');
let log = require('debug')('loopback:connector:elasticsearch');
let elasticsearch = require('elasticsearch');
let Connector = require('loopback-connector').Connector;

/*eslint no-console: ['error', { allow: ['trace','log'] }] */

/**
 * Initialize connector with datasource, configure settings and return
 * @param {object} dataSource
 * @param {function} callback callback
 */
module.exports.initialize = function (dataSource, callback) {
  if (!elasticsearch) {
    return;
  }

  let settings = dataSource.settings || {};

  dataSource.connector = new ESConnector(settings, dataSource);

  if (callback) {
    dataSource.connector.connect(callback);
  }
};

/**
 * Connector constructor
 * @param {object} settings settings
 * @param {object} dataSource
 * @constructor
 */
let ESConnector = function (settings, dataSource) {
  Connector.call(this, 'elasticsearch', settings);

  this.searchIndex = settings.index || 'shakespeare';
  this.searchIndexSettings = settings.settings || {};
  this.searchType = settings.mappingType || '';
  this.defaultSize = (settings.defaultSize || 9999);
  this.idField = 'id';
  this.apiVersion = (settings.apiVersion || '7.0');
  this.refreshOn = (settings.refreshOn || ['create', 'save', 'destroy', 'destroyAll', 'updateAttributes', 'updateOrCreate', 'updateAll', 'replaceOrCreate', 'replaceById']);

  this.debug = settings.debug || log.enabled;
  if (this.debug) {
    log('Settings: %j', settings);
  }

  this.dataSource = dataSource;
};

/**
 * Inherit the prototype methods
 */
util.inherits(ESConnector, Connector);


ESConnector.prototype.queryMap = require('./mappingELIInvenioProperties');

/**
 * Generate a client configuration object based on settings.
 */
ESConnector.prototype.getClientConfig = function () {
  // http://www.elastic.co/guide/en/elasticsearch/client/javascript-api/current/configuration.html
  let config = {
    hosts: this.settings.hosts || {
      host: '127.0.0.1',
      port: 9200
    },
    requestTimeout: this.settings.requestTimeout,
    apiVersion: this.settings.apiVersion,
    log: [{
      type: 'stdio',
      levels: ['error', 'warning'] // change these options
    }],
    suggestCompression: true
  };

  if (this.settings.amazonES) {
    config.connectionClass = require('http-aws-es');
    config.amazonES = this.settings.amazonES || {
      region: 'us-east-1',
      accessKey: 'AKID',
      secretKey: 'secret'
    }
  }

  if (this.settings.ssl) {
    config.ssl = {
      ca: (this.settings.ssl.ca) ? fs.readFileSync(path.join(__dirname, this.settings.ssl.ca)) : fs.readFileSync(path.join(__dirname, '..', 'cacert.pem')),
      rejectUnauthorized: this.settings.ssl.rejectUnauthorized || true
    };
  }
  // Note: http://www.elastic.co/guide/en/elasticsearch/client/javascript-api/current/configuration.html
  //       Due to the complex nature of the configuration, the config object you pass in will be modified
  //       and can only be used to create one Client instance.
  //       Related Github issue: https://github.com/elasticsearch/elasticsearch-js/issues/33
  //       Luckily getClientConfig() pretty much clones settings so we shouldn't have to worry about it.
  return config;
};

/**
 * Connect to Elasticsearch client
 * @param {Function} [callback] The callback function
 *
 * @callback callback
 */
ESConnector.prototype.connect = function (callback) {
  // TODO: throw error if callback isn't provided?
  //       what are the corner-cases when the loopback framework does not provide callback
  //       and we need to be able to live with that?
  let self = this;
  if (self.db) {
    process.nextTick(function () {
      callback && callback(null, self.db);
    });
  } else {
    self.db = new elasticsearch.Client(self.getClientConfig());
    self.db.ping({
      requestTimeout: self.settings.requestTimeout
    }, function (error) {
      if (error) {
        console.log('ESConnector.prototype.connect', 'ping', 'failed', error);
        log('ESConnector.prototype.connect', 'ping', 'failed', error);
      }
    });
    if (self.settings.mappingProperties) {
      self.setupMappings()
        .then(function () {
          log('ESConnector.prototype.connect', 'setupMappings', 'finished');
          callback && callback(null, self.db);
        })
        .catch(function (err) {
          log('ESConnector.prototype.connect', 'setupMappings', 'failed', err);
          callback && callback(null, self.db);
        });
    } else {
      process.nextTick(function () {
        callback && callback(null, self.db);
      });
    }
  }
};

/**
 * Delete a mapping (type definition) along with its data.
 *
 * @param modelNames
 * @param callback
 */
ESConnector.prototype.removeMappings = function (modelNames, callback) {
  let self = this;
  let db = self.db;
  let settings = self.settings;
  if (_.isFunction(modelNames)) {
    callback = modelNames;
    modelNames = _.map(settings.mappings, 'name');
  }
  log('ESConnector.prototype.removeMappings', 'modelNames', modelNames);

  let mappingsToRemove = _.filter(settings.mappings, function (mapping) {
    return !modelNames || _.includes(modelNames, mapping.name);
  });
  log('ESConnector.prototype.removeMappings', 'mappingsToRemove', _.map(mappingsToRemove, 'name'));

  Promise.map(mappingsToRemove, function (mapping) {
    let defaults = self.addDefaults(mapping.name, 'removeMappings');
    log('ESConnector.prototype.removeMappings', 'calling self.db.indices.existsType()');
    return db.indices.existsType(defaults).then(function (exists) {
      if (!exists) return Promise.resolve();
      log('ESConnector.prototype.removeMappings', 'calling self.db.indices.deleteMapping()');
      return db.indices.deleteMapping(defaults).then(function (body) {
        log('ESConnector.prototype.removeMappings', mapping.name, body);
        return Promise.resolve();
      }, function (err) {
        log('ESConnector.prototype.removeMappings', err.message);
        return Promise.reject(err);
      });
    }, function (err) {
      log('ESConnector.prototype.removeMappings', err.message);
      return Promise.reject(err);
    });
  }, {
    concurrency: 1
  }).then(function () {
    log('ESConnector.prototype.removeMappings', 'finished');
    callback(null, self.db); // TODO: what does the connector framework want back as arguments here?
  }).catch(function (err) {
    log('ESConnector.prototype.removeMappings', 'failed');
    callback(err);
  });
};

ESConnector.prototype.setupMappings = require('./setupMappings.js')({
  log: log,
  lodash: _,
  bluebird: Promise
});

ESConnector.prototype.setupMapping = require('./setupMapping.js')({
  log: log,
  lodash: _,
  bluebird: Promise
});

ESConnector.prototype.setupIndex = require('./setupIndex.js')({
  log: log,
  bluebird: Promise
});


/**
 * Ping to test elastic connection
 * @returns {String} with ping result
 */
ESConnector.prototype.ping = function (cb) {
  let self = this;
  self.db.ping({
    requestTimeout: self.settings.requestTimeout
  }, function (error) {
    if (error) {
      log('Could not ping ES.');
      cb(error);
    } else {
      log('Pinged ES successfully.');
      cb();
    }
  });
};

/**
 * Return connector type
 * @returns {Array} type description
 */
ESConnector.prototype.getTypes = function () {
  return [this.name];
};

/**
 * Get value from property checking type
 * @param {object} property
 * @param {object} value
 * @returns {object}
 */
ESConnector.prototype.getValueFromProperty = function (property, value) {
  if (property.type instanceof Array) {
    if (!value || (value.length === 0)) {
      return [];
    } else {
      return value;
    }
  } else if (property.type === String) {
    if (value instanceof Array) {
      return value;
    } else {
      return value.toString();
    }
  } else if (property.type === Number) {
    return Number(value);
  } else if (property.type === Date) {
    return new Date(value);
  } else {
    return value;
  }
};

/**
 *
 * @param {String} propertyKey
 * @param {Object} data
 * @param {CallableFunction} resultFormatter
 * @returns {Object}
 */
ESConnector.prototype.getValueFromDataObject = function (propertyKey, resultFormatter, data) {
  let dataValue = data;
  const keys = propertyKey.split('.');
  if (dataValue !== undefined) {
    for (let k of keys) {
      dataValue = dataValue[k] || undefined;
      if (dataValue === undefined) {
        break;
      }
    }
  }
  if (resultFormatter !== undefined) {
    dataValue = resultFormatter(dataValue, propertyKey, data);
  }
  return dataValue;
};

/**
 * Match and transform data structure to modelName
 * @param {String} modelName name
 * @param {Object} data from DB
 * @param {String} esId id name in es
 * @param {String} idName id name
 * @returns {object} modeled document
 */
ESConnector.prototype.matchDataToModel = async function (modelName, data, esId, idName) {
  //log('ESConnector.prototype.matchDataToModel', 'modelName', modelName, 'data', JSON.stringify(data,null,0));
  let self = this;
  return await new Promise((resolve, reject) => {
    if (!data) {
      resolve(null);
    }
    try {
      let document = {};
      let subqueries = [];
      let properties = this._models[modelName].properties;
      // _.assign(document, data); // it can't be this easy, can it?
      document[idName] = esId;

      for (let propertyName in properties) {
        let propertyData = self.queryMap[modelName + '.' + propertyName] || {}
        let propertyValue = undefined;
        if (propertyData['model'] !== undefined) {
          subqueries.push(new Promise((resolve, reject) => {
            let pname = propertyName;
            self.all(propertyData['model'], {
                'native': {
                  "fields": ["id"],
                  "_source": false,
                  'query': {
                    'bool': {
                      'must': [{
                        "query_string": {
                          "query": self.queryMap[propertyData['model']]['key'] + ' && ' + [(propertyData['subrecord'] || "pid")] + ':' + (propertyData['valueFormatter'] || ((value)=>value))(data.id)
                        }
                      }]
                    }
                  }
                }
              }, function (err, result) {
                if (err !== undefined && err !== null) {
                  log('ESConnector.prototype.matchDataToModel', 'document', err);
                }
                let propertyValue = self.getValueFromDataObject(propertyData['property'] || "pid", propertyData['resultFormatter'], result[0]);
                if (propertyValue !== undefined && propertyValue.length > 0) {
                  propertyValue = propertyValue[0];
                }
                if (propertyValue !== undefined && propertyValue !== null) {
                  document[pname] = self.getValueFromProperty(properties[pname], propertyValue);
                }
                resolve(true);
            });
          }));
        } else {
          propertyValue = self.getValueFromDataObject(propertyData['key'] || propertyName, propertyData['resultFormatter'], data);
        }
        // log('ESConnector.prototype.matchDataToModel', propertyName, propertyValue);
        if (propertyValue !== undefined && propertyValue !== null) {
          if (Object(propertyValue).constructor.name === 'Promise') {
            let pn = propertyName;
            propertyValue.then((value) => {
              document[pn] = self.getValueFromProperty(properties[pn], value);
            })
            subqueries.push(propertyValue);
          } else {
            document[propertyName] = self.getValueFromProperty(properties[propertyName], propertyValue);
          }
        }
      }
      if (subqueries.length > 0) {
        Promise.all(subqueries).then(function (results) {
          resolve(document);
        });
      } else {
        log('ESConnector.prototype.matchDataToModel', 'document', JSON.stringify(document, null, 0));
        resolve(document);
      }
    } catch (err) {
      log('ESConnector.prototype.matchDataToModel', err.message);
      resolve(null);
    }
  });
};

ESConnector.prototype.matchMultipleDataToModel = async function (modelName, data, esId, idName) {
  let self = this;
  return await new Promise((resolve, reject) => {
    let splitdata = Array();
    if ((self.queryMap[modelName] || {'multiple': false})['multiple']) {
      const fields = (self.queryMap[modelName] || {'fields': ['']})['fields'];
      let keys = fields.map((field) => field.replace('.*', '').split('.'));
      let validator = (self.queryMap[modelName] || {'key': modelName})['key'].split(':');
      let validResult;
      const length = Math.max(...Object.keys(data).map((k) => data[k].length))
      for (let index = 0; index < length; ++index) {
        validResult = false;
        let item = {};
        for (let fieldArray of keys) {
          let d = item;
          for (let key of fieldArray) {
            d[key] = {};
            d = d[key];
          }
        }
        for (let key of Object.keys(data)) {
          if (data[key].length > index || fields.includes(key)) {
            if (key === validator[0]) {
              validResult = RegExp(validator[1].replace('*', '.*')).test(data[key][index]);
            }
            let d = item;
            let kk = key.split('.');
            let lastKey = kk.pop();
            for (let k of kk) {
              if (d[k] === undefined) {
                d[k] = {};
              }
              d = d[k];
            }
            if (fields.includes(key)) {
              d[lastKey] = data[key][0];
            } else {
              d[lastKey] = data[key][index];
            }
          }
        }
        if (validResult) {
          splitdata.push(item);
        }
      }
    }
    let subqueries = splitdata.map(value => self.matchDataToModel(modelName, value, data._id, idName));
    Promise.all(subqueries).then(function (results) {
      resolve(results);
    });
  });
};

/**
 * Convert data source to model
 * @param {String} modelName name
 * @param {Object} data object
 * @param {String} idName name
 * @returns {object} modeled document
 */
ESConnector.prototype.dataSourceToModel = async function (modelName, data, idName) {
  log('ESConnector.prototype.dataSourceToModel', 'modelName', modelName, 'data', JSON.stringify(data, null, 0));

  if ((this.queryMap[modelName] || {'multiple': false})['multiple']) {
    return await this.matchMultipleDataToModel(modelName, data._source || data.fields, data._id, idName);
  } else {
    return await this.matchDataToModel(modelName, data._source || data.fields, data._id, idName);
  }
};

/**
 * Add defaults such as index name and type
 *
 * @param {String} modelName
 * @param {String} functionName The caller function name
 * @returns {object} Filter with index and type
 */
ESConnector.prototype.addDefaults = function (modelName, functionName) {
  let self = this;
  log('ESConnector.prototype.addDefaults', 'modelName:', modelName);

  //TODO: fetch index and type from `self.settings.mappings` too
  let indexFromDatasource, typeFromDatasource;
  indexFromDatasource = self.settings.index;
  typeFromDatasource = self.settings.mappingType;
  let filter = {};
  if (this.searchIndex) {
    filter.index = indexFromDatasource || this.searchIndex;
  }

  // When changing data, wait until the change has been indexed so it is instantly available for search
  if (this.refreshOn.indexOf(functionName) != -1) {
    filter.refresh = true;
  }

  let modelClass = this._models[modelName];
  if (modelClass && _.isObject(modelClass.settings.elasticsearch) && _.isObject(modelClass.settings.elasticsearch.settings)) {
    _.extend(filter, modelClass.settings.elasticsearch.settings);
  }

  if (functionName && modelClass && _.isObject(modelClass.settings.elasticsearch) && _.isObject(modelClass.settings.elasticsearch[functionName])) {
    _.extend(filter, modelClass.settings.elasticsearch[functionName]);
  }

  log('ESConnector.prototype.addDefaults', 'filter:', filter);
  return filter;
};

/**
 * Make filter from criteria, data index and type
 * Ex:
 *   {'body': {'query': {'match': {'title': 'Futuro'}}}}
 *   {'q' : 'Futuro'}
 * @param {String} modelName filter
 * @param {String} idName idName
 * @param {Object} criteria filter
 * @param {number} size of rows to return, if null then skip
 * @param {number} offset to return, if null then skip
 * @returns {object} filter
 */
ESConnector.prototype.buildFilter = function (modelName, idName, criteria, size, offset) {
  let self = this;
  log('ESConnector.prototype.buildFilter', 'model', modelName, 'idName', idName,
    'criteria', JSON.stringify(criteria, null, 0));

  if (idName === undefined || idName === null) {
    throw new Error('idName not set!');
  }

  let filter = this.addDefaults(modelName, 'buildFilter');
  filter.body = {};

  if (size !== undefined && size !== null) {
    filter.size = size;
  }
  if (offset !== undefined && offset !== null) {
    filter.from = offset;
  }

  if (criteria) {
    // `criteria` is set by app-devs, therefore, it overrides any connector level arguments
    if (criteria.limit !== undefined && criteria.limit !== null) {
      filter.size = criteria.limit;
    }
    if (criteria.skip !== undefined && criteria.skip !== null) {
      filter.from = criteria.skip;
    } else if (criteria.offset !== undefined && criteria.offset !== null) { // use offset as an alias for skip
      filter.from = criteria.offset;
    }
    if (criteria.order) {
      log('ESConnector.prototype.buildFilter', 'will delegate sorting to buildOrder()');
      // filter.body.sort = self.buildOrder(modelName, idName, criteria.order);
    } else { // TODO: expensive~ish and no clear guidelines so turn it off?
      //var idNames = this.idNames(model); // TODO: support for compound ids?
      let modelProperties = this._models[modelName].properties;
      if (idName === 'id' && modelProperties.id.generated) {
        //filter.body.sort = ['_id']; // requires mapping to contain: '_id' : {'index' : 'not_analyzed','store' : true}
        log('ESConnector.prototype.buildFilter', 'will sort on _id by default when IDs are meant to be auto-generated by elasticsearch');
        // filter.body.sort = ['_id'];
      } else {
        log('ESConnector.prototype.buildFilter', 'will sort on loopback specified IDs');
        // filter.body.sort = [idName]; // default sort should be based on fields marked as id
      }
    }
    if (criteria.where) {
      filter.body.query = self.buildWhere(modelName, idName, criteria.where).query;
    } else if (criteria.native) {
      filter.body = criteria.native; // assume that the developer has provided ES compatible DSL
    } else if (_.keys(criteria).length === 0) {
      filter.body = {
        'query': {
          'bool': {
            'must': [{
              "query_string": {
                "query": (self.queryMap[modelName] || {'key': modelName})['key'],
              }
            }]
          }
        }
      };
    }
    // For queries without 'where' filter, add docType filter
    else if (!criteria.hasOwnProperty('where')) {
      filter.body.query = self.buildWhere(modelName, idName, criteria.where || {}).query;
    }
    if ((self.queryMap[modelName] || {})['fields'] !== undefined) {
      filter.body['_source'] = false;
      filter.body['fields'] = self.queryMap[modelName]['fields'];
    }
  }

  log('ESConnector.prototype.buildFilter', 'constructed', JSON.stringify(filter, null, 0));
  return filter;
};

/**
 * 1. Words of wisdom from @doublemarked:
 *    > When writing a query without an order specified, the author should not assume any reliable order.
 *    > So if we’re not assuming any order, there is not a compelling reason to potentially slow down
 *    > the query by enforcing a default order.
 * 2. Yet, most connector implementations do enforce a default order ... what to do?
 *
 * @param model
 * @param idName
 * @param order
 * @returns {Array}
 */
ESConnector.prototype.buildOrder = function (model, idName, order) {
  let sort = [];

  let keys = order;
  if (typeof keys === 'string') {
    keys = keys.split(',');
  }
  for (let index = 0, len = keys.length; index < len; index++) {
    let m = keys[index].match(/\s+(A|DE)SC$/);
    let key = keys[index];
    key = key.replace(/\s+(A|DE)SC$/, '').trim();
    if (key === 'id' || key === idName) {
      key = '_id';
    }
    if (m && m[1] === 'DE') {
      //sort[key] = -1;
      let temp = {};
      temp[key] = 'desc';
      sort.push(temp);
    } else {
      //sort[key] = 1;
      sort.push(key);
    }
  }

  return sort;
};

ESConnector.prototype.buildWhere = function (model, idName, where) {
  let self = this;

  let nestedFields = _.map(self.settings.mappingProperties, function (val, key) {
    return val.type == 'nested' ? key : null;
  });
  nestedFields = _.filter(nestedFields, function (v) {
    return v;
  });
  log('ESConnector.prototype.buildWhere', 'model', model, 'idName', idName, 'where', JSON.stringify(where, null, 0));

  let body = {
    query: {
      bool: {
        must: [],
        should: [],
        filter: [],
        must_not: []
      }
    }
  };

  self.buildNestedQueries(body, model, idName, where, nestedFields);
  if (body && body.query && body.query.bool && body.query.bool.must && body.query.bool.must.length === 0) {
    delete body.query.bool['must']; // jshint ignore:line
  }
  if (body && body.query && body.query.bool && body.query.bool.filter && body.query.bool.filter.length === 0) { // jshint ignore:line
    delete body.query.bool['filter']; // jshint ignore:line
  }
  if (body && body.query && body.query.bool && body.query.bool.should && body.query.bool.should.length === 0) {
    delete body.query.bool['should']; // jshint ignore:line
  }
  if (body && body.query && body.query.bool && body.query.bool.must_not && body.query.bool.must_not.length === 0) { // jshint ignore:line
    delete body.query.bool['must_not']; // jshint ignore:line
  }
  if (body && body.query && body.query.bool && _.isEmpty(body.query.bool)) {
    delete body.query['bool']; // jshint ignore:line
  }

  if (body && body.query && _.isEmpty(body.query)) {
    body.query = {
        'bool': {
          'must': [{
            "query_string": {
              "query": (self.queryMap[model] || {'key': model})['key'],
            }
          }]
        }
      }
  }
  return body;
};

ESConnector.prototype.buildNestedQueries = function (body, model, idName, where, nestedFields) {
  /**
   * Return an empty match all object if no property is set in where filter
   * @example {where: {}}
   */
  if (_.keys(where).length === 0) {
    body = {
      'query': {
        'bool': {
          'must': {
            'match_all': {}
          }
        }
      }
    };
    log('ESConnector.prototype.buildNestedQueries', '\nbody', JSON.stringify(body, null, 0));
    return body;
  }
  let rootPath = body.query;
  ESConnector.prototype.buildDeepNestedQueries(true, idName, where, body, rootPath, model, nestedFields);
};

ESConnector.prototype.buildDeepNestedQueries = function (root, idName, where, body, path, model, nestedFields) {
  let self = this;
  _.forEach(where, function (value, key) {
    let cond = value;
    // if (key === 'id' || key === idName) {
    //   key = 'id';
    // }
    if (Object.keys(self.queryMap).includes(model + '.' + key) && self.queryMap[model + '.' + key]['key'] !== undefined) {
      key = self.queryMap[model + '.' + key]['key'];
    }
    let splitKey = key.split('.');
    let isNestedKey = false,
      nestedSuperKey = null;
    if (key.indexOf('.') > -1 && !!splitKey[0] && nestedFields.indexOf(splitKey[0]) > -1) {
      isNestedKey = true;
      nestedSuperKey = splitKey[0];
    }

    if (key === 'and' && Array.isArray(value)) {
      let andPath;
      if (root) {
        andPath = path.bool.must;
      } else {
        let andObject = {
          bool: {
            must: []
          }
        };
        andPath = andObject.bool.must;
        path.push(andObject);
      }
      cond.map(function (c) {
        log('ESConnector.prototype.buildDeepNestedQueries', 'mapped', 'body', JSON.stringify(body, null, 0));
        self.buildDeepNestedQueries(false, idName, c, body, andPath, model, nestedFields);
      });
    } else if (key === 'or' && Array.isArray(value)) {
      let orPath;
      if (root) {
        orPath = path.bool.should;
      } else {
        let orObject = {
          bool: {
            should: []
          }
        };
        orPath = orObject.bool.should;
        path.push(orObject);
      }
      cond.map(function (c) {
        log('ESConnector.prototype.buildDeepNestedQueries', 'mapped', 'body', JSON.stringify(body, null, 0));
        self.buildDeepNestedQueries(false, idName, c, body, orPath, model, nestedFields);
      });
    } else {
      let spec = false;
      let options = null;
      if (cond && cond.constructor.name === 'Object') { // need to understand
        options = cond.options;
        spec = Object.keys(cond)[0];
        cond = cond[spec];
      }
      log('ESConnector.prototype.buildNestedQueries',
        'spec', spec, 'key', key, 'cond', JSON.stringify(cond, null, 0), 'options', options);
      if (spec) {
        if (spec === 'gte' || spec === 'gt' || spec === 'lte' || spec === 'lt') {
          let rangeQuery = {
            range: {}
          };
          let rangeQueryGuts = {};
          rangeQueryGuts[spec] = cond;
          rangeQuery.range[key] = rangeQueryGuts;

          // Additional handling for nested Objects
          if (isNestedKey) {
            rangeQuery = {
              'nested': {
                'path': nestedSuperKey,
                'score_mode': 'max',
                'query': rangeQuery
              }
            }
          }

          if (root) {
            path.bool.must.push(rangeQuery);
          } else {
            path.push(rangeQuery);
          }
        }

        /**
         * Logic for loopback `between` filter of where
         * @example {where: {size: {between: [0,7]}}}
         */
        if (spec === 'between') {
          if (cond.length == 2 && (cond[0] <= cond[1])) {
            let betweenArray = {
              range: {}
            };
            betweenArray.range[key] = {
              gte: cond[0],
              lte: cond[1]
            };

            // Additional handling for nested Objects
            if (isNestedKey) {
              betweenArray = {
                'nested': {
                  'path': nestedSuperKey,
                  'score_mode': 'max',
                  'query': betweenArray
                }
              }
            }
            if (root) {
              path.bool.must.push(betweenArray);
            } else {
              path.push(betweenArray);
            }
          }
        }
        /**
         * Logic for loopback `inq`(include) filter of where
         * @example {where: { property: { inq: [val1, val2, ...]}}}
         */
        if (spec === 'inq') {
          let inArray = {
            terms: {}
          };
          inArray.terms[key] = cond;
          // Additional handling for nested Objects
          if (isNestedKey) {
            inArray = {
              'nested': {
                'path': nestedSuperKey,
                'score_mode': 'max',
                'query': inArray
              }
            }
          }
          if (root) {
            path.bool.must.push(inArray);
          } else {
            path.push(inArray);
          }
          log('ESConnector.prototype.buildDeepNestedQueries',
            'body', body,
            'inArray', JSON.stringify(inArray, null, 0));
        }

        /**
         * Logic for loopback `nin`(not include) filter of where
         * @example {where: { property: { nin: [val1, val2, ...]}}}
         */
        if (spec === 'nin') {
          let notInArray = {
            terms: {}
          };
          notInArray.terms[key] = cond;
          // Additional handling for nested Objects
          if (isNestedKey) {
            notInArray = {
              'nested': {
                'path': nestedSuperKey,
                'score_mode': 'max',
                'query': {
                  bool: {
                    must: [notInArray]
                  }
                }
              }
            }
          }
          if (root) {
            path.bool.must_not.push(notInArray);
          } else {
            path.push({
              bool: {
                must_not: [notInArray]
              }
            });
          }
        }

        /**
         * Logic for loopback `neq` (not equal) filter of where
         * @example {where: {role: {neq: 'lead' }}}
         */
        if (spec === 'neq') {
          /**
           * First - filter the documents where the given property exists
           * @type {{exists: {field: *}}}
           */
          // var missingFilter = {exists :{field : key}};
          /**
           * Second - find the document where value not equals the given value
           * @type {{term: {}}}
           */
          let notEqual = {
            term: {}
          };
          notEqual.term[key] = cond;
          /**
           * Apply the given filter in the main filter(body) and on given path
           */
          // Additional handling for nested Objects
          if (isNestedKey) {
            notEqual = {
              'match': {}
            };
            notEqual.match[key] = cond;
            notEqual = {
              'nested': {
                'path': nestedSuperKey,
                'score_mode': 'max',
                'query': {
                  bool: {
                    must: [notEqual]
                  }
                }
              }
            }
          }
          if (root) {
            path.bool.must_not.push(notEqual);
          } else {
            path.push({
              bool: {
                must_not: [notEqual]
              }
            });
          }


          // body.query.bool.must.push(missingFilter);
        }
        // TODO: near - For geolocations, return the closest points, sorted in order of distance.  Use with limit to return the n closest points.
        // TODO: like, nlike
        // TODO: ilike, inlike
        if (spec === 'like') {
          let likeQuery = {
            regexp: {}
          };
          likeQuery.regexp[key] = cond;

          // Additional handling for nested Objects
          if (isNestedKey) {
            likeQuery = {
              'nested': {
                'path': nestedSuperKey,
                'score_mode': 'max',
                'query': {
                  'bool': {
                    'must': [likeQuery]
                  }
                }
              }
            }
          }
          if (root) {
            path.bool.must.push(likeQuery);
          } else {
            path.push(likeQuery);
          }
        }

        if (spec === 'nlike') {
          let nlikeQuery = {
            regexp: {}
          };
          nlikeQuery.regexp[key] = cond;

          // Additional handling for nested Objects
          if (isNestedKey) {
            nlikeQuery = {
              'nested': {
                'path': nestedSuperKey,
                'score_mode': 'max',
                'query': {
                  bool: {
                    'must_not': [nlikeQuery]
                  }
                }
              }
            }
          }
          if (root) {
            path.bool.must_not.push(nlikeQuery);
          } else {
            path.push({
              bool: {
                must_not: [nlikeQuery]
              }
            });
          }
        }
        // TODO: regex

        // geo_shape || geo_distance || geo_bounding_box
        if (spec === 'geo_shape' || spec === 'geo_distance' || spec === 'geo_bounding_box') {
          let geoQuery = {
            'filter': {}
          };
          geoQuery.filter[spec] = cond;

          if (isNestedKey) {
            geoQuery = {
              'nested': {
                'path': nestedSuperKey,
                'score_mode': 'max',
                'query': {
                  'bool': geoQuery
                }
              }
            }
            if (root) {
              path.bool.must.push(geoQuery);
            } else {
              path.push(geoQuery);
            }
          } else {
            if (root) {
              path.bool.filter = geoQuery;
            } else {
              path.push({
                'bool': geoQuery
              });
            }
          }

        }
      } else {
        key = (self.queryMap[model + '.' + key] || {})['key'] || key
        let nestedQuery = {};
        if (typeof value === 'string') {
          value = value.trim();
          if (value.indexOf(' ') > -1) {
            nestedQuery.match_phrase = {};
            nestedQuery.match_phrase[key] = value;
          } else {
            nestedQuery.match = {};
            nestedQuery.match[key] = value;
          }
        } else {
          nestedQuery.match = {};
          nestedQuery.match[key] = value;
        }
        // Additional handling for nested Objects
        if (isNestedKey) {
          nestedQuery = {
            'nested': {
              'path': nestedSuperKey,
              'score_mode': 'max',
              'query': {
                'bool': {
                  'must': [nestedQuery]
                }
              }
            }
          }
        }

        if (root) {
          path.bool.must.push(nestedQuery)
        } else {
          path.push(nestedQuery);
        }

        log('ESConnector.prototype.buildDeepNestedQueries',
          'body', body,
          'nestedQuery', JSON.stringify(nestedQuery, null, 0));
      }
    }
  });
};

/**
 * Get document Id validating data
 * @param {String} id
 * @constructor
 */
ESConnector.prototype.getDocumentId = function (id) {
  try {
    if (typeof id !== 'string') {
      return id.toString();
    } else {
      return id;
    }
  } catch (e) {
    return id;
  }
};

/**
 * Implement CRUD Level I - Key methods to be implemented by a connector to support full CRUD
 * > Create a new model instance
 *   > CRUDConnector.prototype.create = function (model, data, callback) {...};
 * > Query model instances by filter
 *   > CRUDConnector.prototype.all = function (model, filter, callback) {...};
 * > Delete model instances by query
 *   > CRUDConnector.prototype.destroyAll = function (model, where, callback) {...};
 * > Update model instances by query
 *   > CRUDConnector.prototype.updateAll = function (model, where, data, callback) {...};
 * > Count model instances by query
 *   > CRUDConnector.prototype.count = function (model, callback, where) {...};
 * > getDefaultIdType
 *   > very useful for setting a default type for IDs like 'string' rather than 'number'
 };
 */

ESConnector.prototype.getDefaultIdType = function () {
  return String;
};

/**
 * Create a new model instance
 * @param {String} model name
 * @param {object} data info
 * @param {Function} done - invoke the callback with the created model's id as an argument
 */
ESConnector.prototype.create = function (model, data, done) {
  let self = this;
  if (self.debug) {
    log('ESConnector.prototype.create', model, data);
  }

  let idValue = self.getIdValue(model, data);
  let idName = self.idName(model);
  log('ESConnector.prototype.create', 'idName', idName, 'idValue', idValue);
  //TODO: If model has custom id with generated false and if Id field is not prepopulated then create should fail.
  //TODO: If model Id is not string and generated is true then create should fail because the auto generated es id is of type string and we cannot change it.
  let document = self.addDefaults(model, 'create');
  document[self.idField] = self.getDocumentId(idValue);
  document.body = {};
  _.assign(document.body, data);
  log('ESConnector.prototype.create', 'document', document);
  let method = 'create';
  if (!document[self.idField]) {
    method = 'index'; // if there is no/empty id field, we must use the index method to create it (API 5.0)
  }
  //document.body.docType = model;
  self.db[method](
    document
  ).then(
    function (response) {
      log('ESConnector.prototype.create', 'response', response);
      log('ESConnector.prototype.create', 'will invoke callback with id:', response._id);
      done(null, response._id); // the connector framework expects the id as a return value
    }
  ).catch(function (err) {
    log('ESConnector.prototype.create', err.message);
    if (err) {
      return done(err, null);
    }
  });
};

/**
 * Query model instances by filter
 * @param {String} model The model name
 * @param {Object} filter The filter
 * @param {Function} done callback function
 *
 * NOTE: UNLIKE create() where the ID is returned not as a part of the created content
 * but rather individually as an argument to the callback ... in the all() method
 * it makes sense to return the id with the content! So for a datasource like elasticsearch,
 * make sure to map '_id' into the content, just in case its an auto-generated one.
 */
ESConnector.prototype.all = function all(model, filter, done) {
  let self = this;
  log('ESConnector.prototype.all', 'model', model, 'filter', JSON.stringify(filter, null, 0));

  let idName = self.idName(model);
  log('ESConnector.prototype.all', 'idName', idName);
  self.db.search(
    self.buildFilter(model, idName, filter, self.defaultSize, undefined)
  ).then(
    function (body) {
      let resolver = function(items) {
        let data = items.map(async item => self.dataSourceToModel(model, item, idName));
        Promise.all(data).then(function (results) {
          log('ESConnector.prototype.all', 'model', model, 'result', JSON.stringify(results, null, 2));
          if ((self.queryMap[model] || {'multiple': false})['multiple']) {
            let multiple_results = Array();
            let result_hashes = new Set();
            for (let res of results){
              for (let item of res) {
                if (!result_hashes.has(hash(item))) {
                  result_hashes.add(hash(item));
                  multiple_results.push(item);
                }
              }
            }
            results = multiple_results;
          }
          if (filter && filter.include) {
            self._models[model].model.include(results, filter.include, done);
          } else {
            done(null, results);
          }
        });
      }
      let resultData = body.hits.hits;
      let preprocessData = (self.queryMap[model] || {})['preprocessData']
      if (preprocessData !== undefined) {
        resultData = preprocessData(resultData);
      }
      if (Object(resultData).constructor.name === 'Promise') {
        resultData.then(function (results) {resolver(results)})
      } else {
        resolver(resultData);
      }
    },
    function (err) {
      log('ESConnector.prototype.all', err.message);
      if (err) {
        return done(err, null);
      }
    }
  );
};

/**
 * Delete model instances by query
 * @param {String} modelName name
 * @param {String} whereClause criteria
 * @param {Function} cb callback
 */
ESConnector.prototype.destroyAll = function destroyAll(modelName, whereClause, cb) {
  let self = this;

  if ((!cb) && _.isFunction(whereClause)) {
    cb = whereClause;
    whereClause = {};
  }
  log('ESConnector.prototype.destroyAll', 'modelName', modelName, 'whereClause', JSON.stringify(whereClause, null, 0));

  let idName = self.idName(modelName);
  let body = {
    query: self.buildWhere(modelName, idName, whereClause).query
  };

  let defaults = self.addDefaults(modelName, 'destroyAll');
  let options = _.defaults({
    body: body
  }, defaults);
  log('ESConnector.prototype.destroyAll', 'options:', JSON.stringify(options, null, 2));
  self.db.deleteByQuery(options)
    .then(function (response) {
      cb(null, response);
    })
    .catch(function (err) {
      log('ESConnector.prototype.destroyAll', err.message);
      return cb(err, null);
    });
};

/**
 * Update model instances by query
 *
 * NOTES:
 * > Without an update by query plugin, this isn't supported by ES out-of-the-box
 * > To run updateAll these parameters should be enabled in elasticsearch config
 *   -> script.inline: true
 *   -> script.indexed: true
 *   -> script.engine.groovy.inline.search: on
 *   -> script.engine.groovy.inline.update: on
 *
 * @param {String} model The model name
 * @param {Object} where The search criteria
 * @param {Object} data The property/value pairs to be updated
 * @param {Object} options options
 * @param {Function} cb - should be invoked with a second callback argument
 *                           that provides the count of affected rows in the callback
 *                           such as cb(err, {count: affectedRows}).
 *                           Notice the second argument is an object with the count property
 *                           representing the number of rows that were updated.
 */
ESConnector.prototype.updateAll = function updateAll(model, where, data, options, cb) {
  let self = this;
  if (self.debug) {
    log('ESConnector.prototype.updateAll', 'model', model, 'options', options, 'where', where, 'date', data);
  }
  let idName = self.idName(model);
  log('ESConnector.prototype.updateAll', 'idName', idName);

  let defaults = self.addDefaults(model, 'updateAll');

  let body = {
    query: self.buildWhere(model, idName, where).query
  };

  body.script = {
    inline: '',
    params: {}
  };
  _.forEach(data, function (value, key) {
    if (key !== '_id' || key !== idName) {
      // default language for inline scripts is painless if ES 5, so this needs the extra params.
      body.script.inline += 'ctx._source.' + key + '=params.' + key + ';';
      body.script.params[key] = value;
      if (key === 'docType') {
        body.script.params[key] = model;
      }
    }
  });

  let document = _.defaults({
    body: body
  }, defaults);
  log('ESConnector.prototype.updateAll', 'document to update', document);

  self.db.updateByQuery(document)
    .then(function (response) {
      log('ESConnector.prototype.updateAll', 'response', response);
      return cb(null, {
        updated: response.updated,
        total: response.total
      });
    }, function (err) {
      log('ESConnector.prototype.updateAll', err.message);
      if (err) {
        return cb(err, null);
      }
    });
};

ESConnector.prototype.update = ESConnector.prototype.updateAll;

/**
 * Count model instances by query
 * @param {String} modelName name
 * @param {String} where criteria
 * @param {Function} done callback
 */
ESConnector.prototype.count = function count(modelName, done, where) {
  let self = this;
  log('ESConnector.prototype.count', 'model', modelName, 'where', where);

  let idName = self.idName(modelName);
  let body = where.native ? where.native : {
    query: self.buildWhere(modelName, idName, where).query
  };

  if ((this.queryMap[modelName] || {'multiple': false})['multiple']) {
    self.all(modelName, {'where': where}, function(error, result) {
      if (error !== null) {
        done(error, null);
      } else {
        done(null, result.length);
      }
    });
  } else {
    let defaults = self.addDefaults(modelName, 'count');
    self.db.count(_.defaults({
      body: body
    }, defaults)).then(
      function (response) {
        done(null, response.count);
      },
      function (err) {
        log('ESConnector.prototype.count', err.message);
        if (err) {
          return done(err, null);
        }
      }
    );
  }
};

/**
 * Implement CRUD Level II - A connector can choose to implement the following methods,
 *                           otherwise, they will be mapped to those from CRUD Level I.
 * > Find a model instance by id
 *   > CRUDConnector.prototype.find = function (model, id, callback) {...};
 * > Delete a model instance by id
 *   > CRUDConnector.prototype.destroy = function (model, id, callback) {...};
 * > Update a model instance by id
 *   > CRUDConnector.prototype.updateAttributes = function (model, id, data, callback) {...};
 * > Check existence of a model instance by id
 *   > CRUDConnector.prototype.exists = function (model, id, callback) {...};
 */

/**
 * Find a model instance by id
 * @param {String} modelName name
 * @param {String} id row identifier
 * @param {Function} done callback
 */
ESConnector.prototype.find = function find(modelName, id, done) {
  let self = this;
  log('ESConnector.prototype.find', 'model', modelName, 'id', id);

  if (id === undefined || id === null) {
    throw new Error('id not set!');
  }

  let defaults = self.addDefaults(modelName, 'find');
  self.db.get(_.defaults({
    id: self.getDocumentId(id)
  }, defaults)).then(
    function (response) {
      done(null, self.dataSourceToModel(modelName, response));
    },
    function (err) {
      log('ESConnector.prototype.find', err.message);
      if (err) {
        return done(err, null);
      }
    }
  );
};

/**
 * Delete a model instance by id
 * @param {String} modelName name
 * @param {String} id row identifier
 * @param {Function} done callback
 */
ESConnector.prototype.destroy = function destroy(modelName, id, done) {
  let self = this;
  if (self.debug) {
    log('ESConnector.prototype.destroy', 'model', modelName, 'id', id);
  }

  let filter = self.addDefaults(modelName, 'destroy');
  filter[self.idField] = self.getDocumentId(id);
  if (!filter[self.idField]) {
    throw new Error('Document id not setted!');
  }
  self.db.delete(
    filter
  ).then(
    function (response) {
      done(null, response);
    },
    function (err) {
      log('ESConnector.prototype.destroy', err.message);
      if (err) {
        return done(err, null);
      }
    }
  );
};

/**
 * Update a model instance by id
 *
 */

ESConnector.prototype.updateAttributes = function updateAttrs(modelName, id, data, callback) {
  let self = this;
  if (self.debug) {
    log('ESConnector.prototype.updateAttributes', 'modelName', modelName, 'id', id, 'data', data);
  }
  let idName = self.idName(modelName);
  log('ESConnector.prototype.updateAttributes', 'idName', idName);

  let defaults = self.addDefaults(modelName, 'updateAll');

  let body = {
    query: self.buildWhere(modelName, idName, {
      _id: id
    }).query
  };

  body.script = {
    inline: '',
    params: {}
  };
  _.forEach(data, function (value, key) {
    if (key !== '_id' || key !== idName) {
      // default language for inline scripts is painless if ES 5, so this needs the extra params.
      body.script.inline += 'ctx._source.' + key + '=params.' + key + ';';
      body.script.params[key] = value;
      if (key === 'docType') {
        body.script.params[key] = modelName;
      }
    }
  });

  let document = _.defaults({
    body: body
  }, defaults);
  log('ESConnector.prototype.updateAttributes', 'document to update', document);

  self.db.updateByQuery(document)
    .then(function (response) {
      log('ESConnector.prototype.updateAttributes', 'response', response);
      return callback(null, {
        updated: response.updated,
        total: response.total
      });
    }, function (err) {
      log('ESConnector.prototype.updateAttributes', err.message);
      if (err) {
        return callback(err, null);
      }
    });
};

/**
 * Check existence of a model instance by id
 * @param {String} modelName name
 * @param {String} id row identifier
 * @param {function} done callback
 */
ESConnector.prototype.exists = function (modelName, id, done) {
  let self = this;
  log('ESConnector.prototype.exists', 'model', modelName, 'id', id);

  if (id === undefined || id === null) {
    throw new Error('id not set!');
  }

  let defaults = self.addDefaults(modelName, 'exists');
  self.db.exists(_.defaults({
    id: self.getDocumentId(id)
  }, defaults)).then(
    function (exists) {
      done(null, exists);
    },
    function (err) {
      log('ESConnector.prototype.exists', err.message);
      if (err) {
        return done(err, null);
      }
    }
  );
};

/**
 * Implement CRUD Level III - A connector can also optimize certain methods
 *                            if the underlying database provides native/atomic
 *                            operations to avoid multiple calls.
 * > Save a model instance
 *   > CRUDConnector.prototype.save = function (model, data, callback) {...};
 * > Find or create a model instance
 *   > CRUDConnector.prototype.findOrCreate = function (model, data, callback) {...};
 * > Update or insert a model instance
 *   > CRUDConnector.prototype.updateOrCreate = function (model, data, callback) {...};
 */

/**
 * Update document data
 * @param {String} model name
 * @param {Object} data document
 * @param {Function} done callback
 */
ESConnector.prototype.save = function (model, data, done) {
  let self = this;
  if (self.debug) {
    log('ESConnector.prototype.save ', 'model', model, 'data', data);
  }

  let idName = self.idName(model);
  let defaults = self.addDefaults(model, 'save');
  let id = self.getDocumentId(data[idName]);

  if (id === undefined || id === null) {
    return done('Document id not setted!', null);
  }
  //data.docType = model;
  self.db.update(_.defaults({
    id: id,
    body: {
      doc: data,
      'doc_as_upsert': false
    }
  }, defaults)).then(function (response) {
    done(null, response);
  }, function (err) {
    if (err) {
      return done(err, null);
    }
  });
};

/**
 * Find or create a model instance
 */
//ESConnector.prototype.findOrCreate = function (model, data, callback) {...};

/**
 * Update or insert a model instance
 * @param modelName
 * @param data
 * @param callback - should pass the following arguments to the callback:
 *                   err object (null on success)
 *                   data object containing the property values as found in the database
 *                   info object providing more details about the result of the operation.
 *                               At the moment, it should have a single property isNewInstance
 *                               with the value true if a new model was created
 *                               and the value false is an existing model was found & updated.
 */
ESConnector.prototype.updateOrCreate = function updateOrCreate(modelName, data, callback) {
  let self = this;
  log('ESConnector.prototype.updateOrCreate', 'modelName', modelName, 'data', data);

  let idName = self.idName(modelName);
  let id = self.getDocumentId(data[idName]);
  if (id === undefined || id === null) {
    throw new Error('id not set!');
  }

  let defaults = self.addDefaults(modelName, 'updateOrCreate');
  //data.docType = modelName;
  self.db.update(_.defaults({
    id: id,
    body: {
      doc: data,
      'doc_as_upsert': true
    }
  }, defaults)).then(
    function (response) {
      /**
       * In the case of an update, elasticsearch only provides a confirmation that it worked
       * but does not provide any model data back. So what should be passed back in
       * the data object (second argument of callback)?
       *   Q1) Should we just pass back the data that was meant to be updated
       *       and came in as an argument to the updateOrCreate() call? This is what
       *       the memory connector seems to do.
       *       A: [Victor Law] Yes, that's fine to do. The reason why we are passing the data there
       *       and back is to support databases that can add default values to undefined properties,
       *       typically the id property is often generated by the backend.
       *   Q2) OR, should we make an additional call to fetch the data for that id internally,
       *       within updateOrCreate()? So we can make sure to pass back a data object?
       *       A: [Victor Law]
       *          - Most connectors don't fetch the inserted/updated data and hope the data stored into DB
       *            will be the same as the data sent to DB for create/update.
       *          - It's true in most cases but not always. For example, the DB might have triggers
       *            that change the value after the insert/update.
       *            - We don't support that yet.
       *            - In the future, that can be controlled via an options property,
       *              such as fetchNewInstance = true.
       *
       * NOTE: Q1 based approach has been implemented for now.
       */
      if (response._version === 1) { // distinguish if it was an update or create operation in ES
        data[idName] = response._id;
        log('ESConnector.prototype.updateOrCreate', 'assigned ID', idName, '=', response._id);
      }
      callback(null, data, {
        isNewInstance: response.created
      });
    },
    function (err) {
      log('ESConnector.prototype.updateOrCreate', err.message);
      if (err) {
        return callback(err, null);
      }
    }
  );
};

/**
 * replace or insert a model instance
 * @param modelName
 * @param data
 * @param callback - should pass the following arguments to the callback:
 *                   err object (null on success)
 *                   data object containing the property values as found in the database
 *                   info object providing more details about the result of the operation.
 *                               At the moment, it should have a single property isNewInstance
 *                               with the value true if a new model was created
 *                               and the value false is an existing model was found & updated.
 */
ESConnector.prototype.replaceOrCreate = function (modelName, data, callback) {
  let self = this;
  log('ESConnector.prototype.replaceOrCreate', 'modelName', modelName, 'data', data);

  let idName = self.idName(modelName);
  let id = self.getDocumentId(data[idName]);
  if (id === undefined || id === null) {
    throw new Error('id not set!');
  }

  let document = self.addDefaults(modelName, 'replaceOrCreate');
  document[self.idField] = id;
  document.body = {};
  _.assign(document.body, data);
  //document.body.docType = modelName;
  log('ESConnector.prototype.replaceOrCreate', 'document', document);
  self.db.index(
    document
  ).then(
    function (response) {
      log('ESConnector.prototype.replaceOrCreate', 'response', response);
      log('ESConnector.prototype.replaceOrCreate', 'will invoke callback with id:', response._id);
      callback(null, response._id); // the connector framework expects the id as a return value
    }
  ).catch(function (err) {
    log('ESConnector.prototype.replaceOrCreate', err.message);
    if (err) {
      return callback(err, null);
    }
  });
};

ESConnector.prototype.replaceById = function replace(modelName, id, data, options, callback) {
  let self = this;
  log('ESConnector.prototype.replaceById', 'modelName', modelName, 'id', id, 'data', data);

  let idName = self.idName(modelName);
  if (id === undefined || id === null) {
    throw new Error('id not set!');
  }

  let modelProperties = this._models[modelName].properties;

  let document = self.addDefaults(modelName, 'replaceById');
  document[self.idField] = self.getDocumentId(id);
  document.body = {};
  _.assign(document.body, data);
  //document.body.docType = modelName;
  if (modelProperties.hasOwnProperty(idName)) {
    document.body[idName] = id;
  }
  log('ESConnector.prototype.replaceById', 'document', document);
  self.db.index(
    document
  ).then(
    function (response) {
      log('ESConnector.prototype.replaceById', 'response', response);
      log('ESConnector.prototype.replaceById', 'will invoke callback with id:', response._id);
      callback(null, response._id); // the connector framework expects the id as a return value
    }
  ).catch(function (err) {
    log('ESConnector.prototype.replaceById', err.message);
    if (err) {
      return callback(err, null);
    }
  });
};

/**
 * Migration
 *   automigrate - Create/recreate DB objects (such as table/column/constraint/trigger/index)
 *                 to match the model definitions
 *   autoupdate - Alter DB objects to match the model definitions
 */

/**
 * Perform automigrate for the given models. Create/recreate DB objects
 * (such as table/column/constraint/trigger/index) to match the model definitions
 *  --> Drop the corresponding indices: both mappings and data are done away with
 *  --> create/recreate mappings and indices
 *
 * @param {String[]} [models] A model name or an array of model names. If not present, apply to all models
 * @param {Function} [cb] The callback function
 */
ESConnector.prototype.automigrate = require('./automigrate.js')({
  log: log,
  lodash: _,
  bluebird: Promise
});

module.exports.name = ESConnector.name;
module.exports.ESConnector = ESConnector;
