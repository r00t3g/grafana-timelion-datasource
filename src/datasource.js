import _ from "lodash";

export class TimelionDatasource {

    constructor(instanceSettings, $q, backendSrv, templateSrv, timeSrv) {
        instanceSettings.jsonData = instanceSettings.jsonData || {};
        this.instanceSettings = instanceSettings;
        this.esVersion = instanceSettings.jsonData.esVersion || "5.3.0";
        this.type = instanceSettings.type;
        this.url = instanceSettings.url;
        this.name = instanceSettings.name;
        this.q = $q;
        this.backendSrv = backendSrv;
        this.templateSrv = templateSrv;
        this.timeSrv = timeSrv;
    }

    request(options) {
        options.headers = {
            "kbn-version": this.esVersion,
            "Content-Type": "application/json;charset=UTF-8"
        };
        return this.backendSrv.datasourceRequest(options);
    }

    query(options) {
        var query = this.buildQueryParameters(options);
        var oThis = this;
        if (query.targets.length <= 0) {
            return this.q.when({data: []});
        }
        var reqs = _.map(options.queries,
            query => oThis.request({
                url: this.url + '/run',
                data: query,
                method: 'POST'
            })
                .then(response => oThis.readTimlionSeries(response)
                    .map((list, ix) => ({
                        "target": list.label,
                        "datapoints": _.map(list.data, d => [d[1], d[0]])
                    }))));
        return this.q.all(reqs).then(series => ({"data": _.flatten(series)}))
    }

    readTimlionSeries(response) {
        return _.flatten(_.map(response.data.sheet, sheet => sheet.list));
    }

    testDatasource() {
        var testQuery = {
            "sheet": [".es(*)"],
            "time": {
                "from": "now-1m",
                "to": "now",
                "mode": "quick",
                "interval": "auto",
                "timezone": "Europe/Berlin"
            }
        };
        return this.request({
            url: this.url + '/run',
            method: 'POST',
            data: testQuery
        }).then(response => {
            if (response.status === 200) {
                return {status: "success", message: "Data source is working", title: "Success"};
            } else {
                return {status: "error", message: response.body, title: `Error ${response.status}`};
            }
        });
    }

    annotationQuery(options) {
        options.targets = [{target: options.annotation.query}];
        options.scopedVars = {};
        var novalue = parseFloat(options.annotation.novalue || 0);
        return this.query(options)
            .then(result => this.createAnnotations(options,
                _.reduce(
                    _.map(result.data, d =>
                        _.map(_.filter(d.datapoints, dd => dd[0] !== novalue), dp =>
                            ({
                                target: `${d.target}: ${dp[0]}`,
                                timestamp: dp[1]
                            }))
                    )
                    , (acc, v) => acc.concat(v), [])
                )
            );
    }

    annotationReplace(text, match) {
        if (!text || !match) return text;
        for (var s in match) {
            text = text.replace(new RegExp(`\\$${s}`, 'g'), match[s]);
        }
        return this.templateSrv.replace(text, null, 'regex');
    }

    annotationInfo(options, result) {
        var m = options.regexp
            ? new RegExp(options.regexp).exec(result.target)
            : [];

        const tags = (options.tags && options.tags.length) ?
            this.annotationReplace(options.tags, m).split(',') :
            null;

        return {
            title: this.annotationReplace(options.title, m),
            time: result.timestamp,
            text: this.annotationReplace(options.text, m),
            tags: tags
        };
    }

    createAnnotations(options, queryResult) {
        var res = _.map(queryResult, r => Object.assign({
                "annotation": {
                    "name": options.annotation.name,
                    "enabled": options.annotation.enable,
                    "datasource": "Timelion",
                }
            },
            this.annotationInfo(options.annotation, r)
        ));
        return res;
    }

    metricFindQuery(query) {
        var interpolated = {
            target: this.templateSrv.replace(query, null, 'regex')
        };
        return this["query"]({
            targets: [interpolated],
            range: this.timeSrv.timeRange(),
            scopedVars: {}
        })
            .then(series => {
                return _.map(series.data, d => ({text: d.target}));
            });
    }

    mapToTextValue(result) {
        return _.map(result.data, (d, i) => {
            if (d && d.text && d.value) {
                return {text: d.text, value: d.value};
            } else if (_.isObject(d)) {
                return {text: d, value: i};
            }
            return {text: d, value: d};
        });
    }

    buildAdhocString(conditions) {
        return conditions.map((condition) => {
            const value = condition.value.includes(' ') ? `"${condition.value}"` : `${condition.value}`;
            return `${condition.key}${condition.operator}${value}`;
        }).join(' AND ');
    }

    getAdHocFilterConditions() {
        const conditions = [];

        this.templateSrv.variables
            .filter(variable => variable.type === 'adhoc' && variable.filters)
            .forEach((variable) => {
                const {filters = []} = variable;

                filters.forEach((filter) => {
                    const {key, value = ''} = filter;

                    conditions.push({
                        key: filter.operator === "!=" ? `-${key}` : key,
                        value,
                        operator: this.getAdHocFilterConditionOperator(filter.operator)
                    });
                });
            });

        return conditions;
    }

    getAdHocFilterName() {
        const {name = null} = this.templateSrv.variables.find(variable => variable.type === 'adhoc') || {};

        return name;
    }

    getAdHocFilterConditionOperator(filterOperator) {
        switch (filterOperator) {
            case '>':
                return ':>';
            case '<':
                return ':<';
            case '>=':
                return ':>=';
            case '<=':
                return ':<=';
            default:
                return ':';
        }
    }

    expandTemplate(target, options) {
        _.map(
            Object.keys(options.scopedVars),
            key => target = target.replace("$" + key, options.scopedVars[key].value)
        );

        return this.templateSrv
            .replace(target, true)
            .replace(/\r\n|\r|\n/mg, "")
            .trim();
    }

    buildQueryParameters(options) {
        var oThis = this;
        //remove placeholder targets
        options.targets = _.filter(options.targets, target => {
            return target.target !== 'select metric' && !target.hide;
        });

        const adHoc = {
            name: this.getAdHocFilterName(),
            conditions: this.getAdHocFilterConditions(),
        };

        const queryTpl = {
            "sheet": null,
            "time": {
                "from": options.range.from.utc().format("YYYY-MM-DDTHH:mm:ss\\Z"),
                "interval": "auto",
                "mode": "absolute",
                "timezone": "GMT",
                "to": options.range.to.utc().format("YYYY-MM-DDTHH:mm:ss\\Z")
            }
        };

        let targets = _.map(options.targets, target => {
            return {
                target: this.expandTemplate(target.target, options),
                interval: this.expandTemplate(target.interval || "auto", options)
            };
        });

        const selectedInterval = this.templateSrv.variables.find(variable => variable.type === 'interval');
        if (selectedInterval && selectedInterval.current) {
            const {value, name} = selectedInterval.current;
            const intervalRx = new RegExp(`\\.scale_interval\\(${name}\\)`, 'g');
            const replacement = value === 'auto'
                ? '1h'
                : value;

            targets.forEach((target) => {
                target.target = target.target.replace(intervalRx, `.scale_interval(${replacement})`);
            });
        }
        const intervalParseRx = /\.scale_interval\((\d+\w+)\)/
        targets.forEach((target) => {
            const intervalMatches = target.target.match(intervalParseRx);
            if (!intervalMatches) {
                return;
            }

            const intervalValue = intervalMatches[1];
            target.interval = intervalValue;
        })

        const variables = _.filter(
            _.map(options.targets, t => this.expandTemplate(t.target, options)),
            t => t.indexOf("$") == 0
        ).join(",");

        const intervalGroups = _.groupBy(targets, t => t.interval);
        const intervals = Object.keys(intervalGroups);
        const queries = _.map(intervals, key => ({
            interval: key,
            sheet: _.map(intervalGroups[key], target => (variables && variables.length) ?
                [variables, target.target].join(",") :
                target.target)
        }));

        options.queries = _.map(queries, q => {
            if (adHoc.name !== null) {
                const filterStr = this.buildAdhocString(adHoc.conditions);
                const filterRx = new RegExp(`AND_\\$${adHoc.name}`, 'g')
                const valueRx = new RegExp(`\\$${adHoc.name}`, 'g')

                q.sheet = q.sheet.map((query) => {
                    return (filterStr.length
                            ? query.replace(filterRx, "AND " + filterStr)
                            : query.replace(filterRx, "")
                    ).replace(valueRx, filterStr);
                })
            }

            queryTpl.sheet = q.sheet;
            queryTpl.time.interval = !q.interval || q.interval === 'undefined' ? 'auto' : q.interval;
            return _.cloneDeep(queryTpl);
        });
        return options;
    }
}
