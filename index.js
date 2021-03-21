const parser = require("odata-parser");

const dbFunction = [
  "tolower",
  "toupper",
  "trim",
  "year",
  "month",
  "day",
  "hour",
  "minute",
  "second"
];

const complexDbFunction = ["substringof", "startswith"];

const allDbFunctions = dbFunction.concat(complexDbFunction);
const objectOperators = [
  "and",
  "or",
  "between",
  "notBetween",
  "in",
  "notIn",
  "any",
  "overlap",
  "contains",
  "contained"
];
const valueOperators = [
  "gt",
  "gte",
  "lt",
  "lte",
  "ne",
  "eq",
  "not",
  "like",
  "notLike",
  "iLike",
  "notILike",
  "regexp",
  "notRegexp",
  "iRegexp",
  "notIRegexp",
  "col"
];
const customOperators = ["ge", "le"].concat(allDbFunctions);
let mappedValueOperators = [];

function mapOperators(sequelize) {
  mappedValueOperators = valueOperators.map(element => sequelize.Sequelize.Op[element]);
  sequelize.options.operatorsAliases = mappedValueOperators;
}
function getDbFunctionName(functionName) {
  if (functionName == "tolower") {
    return "lower";
  }
  if (functionName == "toupper") {
    return "upper";
  }
  return functionName;
}

function getOperator(strOperator, sequelize) {
  if (!sequelize.Sequelize.Op) throw new Error("Sequelize operator not found.");

  const allOperators = objectOperators.concat(valueOperators).concat(customOperators);
  if (!allOperators.includes(strOperator))
    throw new Error(`Operator not recognized: ${strOperator}`);

  const selectedOperator = sequelize.Sequelize.Op[strOperator];

  if (!selectedOperator) {
    switch (strOperator) {
      case "ge":
        return sequelize.Sequelize.Op.gte;
      case "le":
        return sequelize.Sequelize.Op.lte;
      case "substringof":
      case "startswith":
        return sequelize.Sequelize.Op.like;
      case "tolower":
      case "toupper":
      case "trim":
      case "year":
      case "month":
      case "day":
      case "hour":
      case "minute":
      case "second":
        return sequelize.Sequelize.Op.eq;
      default:
        throw new Error("Sequelize operator not found.");
    }
  } else return selectedOperator;
}

function transformTree(root, sequelize) {
  if (!sequelize.Sequelize.Op) throw new Error("Sequelize operator not found.");

  Object.getOwnPropertySymbols(root).forEach(rootSymbol => {
    if (mappedValueOperators.includes(rootSymbol)) {
      const tmp = root[rootSymbol];
      delete root[rootSymbol];

      const targetObj = tmp[0];
      const key = Object.keys(targetObj)[0];
      const value = targetObj[key];

      if (!!value.constructor && value.constructor.name === "Where") {
        [root] = tmp;
      } else {
        root[key] = {};
        root[key][rootSymbol] = value;
      }
    } else {
      root[rootSymbol].forEach((obj, index) => {
        root[rootSymbol][index] = transformTree(obj, sequelize);
      });
    }
  });

  return root;
}

function addToTree(root, key, value) {
  if (root instanceof Array) {
    root.push({ [key]: value });
  } else {
    root[key] = value;
  }
}

function parseFunction(obj, root, baseOperator, sequelize, tableName) {
  if (!Object.prototype.hasOwnProperty.call(obj, "func")) throw new Error("Function not found.");
  if (!Object.prototype.hasOwnProperty.call(obj, "args")) throw new Error("Args not found.");
  if (!sequelize.where) throw new Error("Sequelize where function not found.");

  const { args } = obj;
  let value = "";
  const operator =
    obj.func === "substringof"
      ? getOperator(obj.func, sequelize)
      : baseOperator || getOperator(obj.func, sequelize);

  let key = parseProperty((args.find(t => t.type == "property") || {}).name, tableName);

  if (!dbFunction.includes(obj.func)) {
    if (obj.func === "substringof") {
      value = `%${args[0].value}%`;
    } else if (obj.func === "startswith") {
      value = `${args[0].value}%`;
    }
    if (key) {
      addToTree(root, key, { [operator]: value });
    } else {
      let func = args.find(t => t.type == "functioncall");
      key = parseProperty((func.args.find(t => t.type == "property") || {}).name, tableName, true);

      addToTree(
        root,
        key,
        sequelize.where(
          sequelize.fn(getDbFunctionName(func.func), sequelize.col(key)),
          operator,
          value
        )
      );
    }
  } else {
    const fn = sequelize.where(
      sequelize.fn(getDbFunctionName(obj.func), sequelize.col(key)),
      operator,
      value
    );
    addToTree(root, key, fn);
  }
}

function parseProperty(property, tableName, explicitTable = false) {
  if (!property) {
    return property;
  }
  if (property.match("/")) {
    return `$${property.replace("/", ".")}$`;
  }
  if (explicitTable && tableName) return `${tableName}.${property}`;
  else return property;
}

function preOrderTraversal(root, baseObj, operator, sequelize, tableName) {
  const strOperator = root.type === "functioncall" ? root.func : root.type;
  if (root.type !== "property" && root.type !== "literal" && root.type !== "functioncall")
    operator = strOperator ? getOperator(strOperator, sequelize) : operator;

  if (root.type === "functioncall") {
    if (allDbFunctions.includes(root.func)) parseFunction(root, baseObj, operator, sequelize, tableName);
  } else if (root.type === "property") {
    addToTree(baseObj, parseProperty(root.name), "", tableName);
  } else if (root.type === "literal") {
    const obj = baseObj[baseObj.length - 1];
    const key = Object.keys(obj)[0];

    if (Object.prototype.hasOwnProperty.call(obj[key], "logic")) {
      obj[key].logic = root.value;
    } else {
      obj[key] = root.value;
    }
  } else {
    addToTree(baseObj, operator, []);
  }

  callPreOrderTraversal(root.left, baseObj, operator, sequelize, tableName);
  callPreOrderTraversal(root.right, baseObj, operator, sequelize, tableName);

  return baseObj;
}

function callPreOrderTraversal(branch, baseObj, operator, sequelize, tableName) {
  if (branch)
    if (baseObj instanceof Array && baseObj.length > 0) {
      const { length } = baseObj;
      preOrderTraversal(branch, baseObj[length - 1][operator], operator, sequelize, tableName);
    } else {
      preOrderTraversal(branch, baseObj[operator], operator, sequelize, tableName);
    }
}

/**
 * Parse OData expression
 * @param {string} expression
 * @return {object} parsed object
 */
function parseExpression(expression) {
  return parser.parse(expression);
}

/**
 * Parse $select
 * @param {string} $select
 * @return {object} parsed object
 */
function parseSelect($select) {
  const attributes = [];

  if ($select) {
    $select.forEach(element => {
      attributes.push(element);
    });
  }

  return attributes.length > 0 ? { attributes } : {};
}

/**
 * Parse $top
 * @param {string} $top
 * @return {number} number of registers to fetch
 */
function parseTop($top) {
  let limit = 0;

  if ($top) {
    limit = $top;
  }

  return limit > 0 ? { limit } : {};
}

/**
 * Parse $skip
 * @param {string} $skip
 * @return {number} number of registers to skip
 */
function parseSkip($skip) {
  let offset = 0;

  if ($skip) {
    offset = $skip;
  }

  return offset > 0 ? { offset } : {};
}

/**
 * Parse $filter
 * @param {string} $filter
 * @return {object} parsed object
 */
function parseFilter($filter, sequelize, tableName) {
  if (!sequelize.Sequelize.Op) throw new Error("Sequelize operator not found.");

  if (!$filter) {
    return {};
  }
  const tree = preOrderTraversal($filter, {}, null, sequelize, tableName);
  const parsed = transformTree(tree, sequelize);

  return { where: parsed };
}

/**
 * Parse $orderby
 * @param {string} $orderby
 * @return {object} parsed object
 */
function parseOrderBy($orderby) {
  const order = [];

  if ($orderby) {
    $orderby.forEach(element => {
      const arr = [];
      const key = Object.keys(element)[0];

      arr.push(key);
      arr.push((element[key] || "asc").toUpperCase());
      order.push(arr);
    });
  }

  return order.length > 0 ? { order } : {};
}

/**
 * Parse an OData string to a sequelize query object
 * @param {string2Parse} OData string to parse
 * @param {sequelize} Sequelize instance
 * @return {object} filled object to pass as query argument
 */
module.exports = (string2Parse, sequelize, tableName) => {
  if (!sequelize) throw new Error("Sequelize instance is required.");
  if (!sequelize.Sequelize.Op) throw new Error("Sequelize operator not found.");

  mapOperators(sequelize);

  const expression = parseExpression(string2Parse);
  const attributes = parseSelect(expression.$select);
  const top = parseTop(expression.$top);
  const skip = parseSkip(expression.$skip);
  const orderby = parseOrderBy(expression.$orderby);
  const filter = parseFilter(expression.$filter, sequelize, tableName);

  return Object.assign({}, attributes, top, skip, orderby, filter);
};
