/*
* Licensed to the Apache Software Foundation (ASF) under one
* or more contributor license agreements.  See the NOTICE file
* distributed with this work for additional information
* regarding copyright ownership.  The ASF licenses this file
* to you under the Apache License, Version 2.0 (the
* "License"); you may not use this file except in compliance
* with the License.  You may obtain a copy of the License at
*
*   http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing,
* software distributed under the License is distributed on an
* "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
* KIND, either express or implied.  See the License for the
* specific language governing permissions and limitations
* under the License.
*/

import * as zrUtil from 'zrender/src/core/util';
import RoamController from './RoamController';
import * as roamHelper from '../../component/helper/roamHelper';
import {onIrrelevantElement} from '../../component/helper/cursorHelper';
import * as graphic from '../../util/graphic';
import geoSourceManager from '../../coord/geo/geoSourceManager';
import {getUID} from '../../util/component';
import ExtensionAPI from '../../ExtensionAPI';
import GeoModel, { GeoCommonOptionMixin, GeoItemStyleOption } from '../../coord/geo/GeoModel';
import MapSeries from '../../chart/map/MapSeries';
import GlobalModel from '../../model/Global';
import { Payload } from '../../util/types';
import GeoView from '../geo/GeoView';
import MapView from '../../chart/map/MapView';
import Region from '../../coord/geo/Region';
import Geo from '../../coord/geo/Geo';
import Model from '../../model/Model';


interface RegionsGroup extends graphic.Group {
    __regions: Region[];
}

function getFixedItemStyle(model: Model<GeoItemStyleOption>) {
    let itemStyle = model.getItemStyle();
    let areaColor = model.get('areaColor');

    // If user want the color not to be changed when hover,
    // they should both set areaColor and color to be null.
    if (areaColor != null) {
        itemStyle.fill = areaColor;
    }

    return itemStyle;
}

function updateMapSelected(mapOrGeoModel: GeoModel | MapSeries, regionsGroup: RegionsGroup) {
    // FIXME
    regionsGroup.eachChild(function (otherRegionEl) {
        zrUtil.each((otherRegionEl as RegionsGroup).__regions, function (region) {
            otherRegionEl.trigger(mapOrGeoModel.isSelected(region.name) ? 'emphasis' : 'normal');
        });
    });
}

class MapDraw {

    private uid: string;

    // @ts-ignore FIXME:TS
    private _controller: RoamController;

    private _controllerHost: {
        target?: graphic.Group;
        zoom?: number;
        zoomLimit?: GeoCommonOptionMixin['scaleLimit'];
    };

    readonly group: graphic.Group;

    private _updateGroup: boolean;

    /**
     * This flag is used to make sure that only one among
     * `pan`, `zoom`, `click` can occurs, otherwise 'selected'
     * action may be triggered when `pan`, which is unexpected.
     */
    private _mouseDownFlag: boolean;

    private _mapName: string;

    private _initialized: string;

    private _regionsGroup: RegionsGroup;

    private _backgroundGroup: graphic.Group;


    constructor(api: ExtensionAPI, updateGroup: boolean) {
        let group = new graphic.Group();
        this.uid = getUID('ec_map_draw');
        // @ts-ignore FIXME:TS
        this._controller = new RoamController(api.getZr());
        this._controllerHost = {target: updateGroup ? group : null};
        this.group = group;
        this._updateGroup = updateGroup;

        group.add(this._regionsGroup = new graphic.Group() as RegionsGroup);
        group.add(this._backgroundGroup = new graphic.Group());
    }

    draw(
        mapOrGeoModel: GeoModel | MapSeries,
        ecModel: GlobalModel,
        api: ExtensionAPI,
        fromView: MapView | GeoView,
        payload: Payload
    ): void {

        let isGeo = mapOrGeoModel.mainType === 'geo';

        // Map series has data. GEO model that controlled by map series
        // will be assigned with map data. Other GEO model has no data.
        let data = (mapOrGeoModel as MapSeries).getData && (mapOrGeoModel as MapSeries).getData();
        isGeo && ecModel.eachComponent({mainType: 'series', subType: 'map'}, function (mapSeries: MapSeries) {
            if (!data && mapSeries.getHostGeoModel() === mapOrGeoModel) {
                data = mapSeries.getData();
            }
        });

        let geo = mapOrGeoModel.coordinateSystem;

        this._updateBackground(geo);

        let regionsGroup = this._regionsGroup;
        let group = this.group;

        let transformInfo = geo.getTransformInfo();
        group.transform = transformInfo.roamTransform;
        group.decomposeTransform();
        group.dirty();

        let scale = transformInfo.rawScale;
        let position = transformInfo.rawPosition;

        regionsGroup.removeAll();

        let itemStyleAccessPath = ['itemStyle'] as const;
        let hoverItemStyleAccessPath = ['emphasis', 'itemStyle'] as const;
        let labelAccessPath = ['label'] as const;
        let hoverLabelAccessPath = ['emphasis', 'label'] as const;
        let nameMap = zrUtil.createHashMap<RegionsGroup>();

        zrUtil.each(geo.regions, function (region) {
            // Consider in GeoJson properties.name may be duplicated, for example,
            // there is multiple region named "United Kindom" or "France" (so many
            // colonies). And it is not appropriate to merge them in geo, which
            // will make them share the same label and bring trouble in label
            // location calculation.
            let regionGroup = nameMap.get(region.name)
                || nameMap.set(region.name, new graphic.Group() as RegionsGroup);

            let compoundPath = new graphic.CompoundPath({
                segmentIgnoreThreshold: 1,
                shape: {
                    paths: []
                }
            });
            regionGroup.add(compoundPath);

            const regionModel = mapOrGeoModel.getRegionModel(region.name) || mapOrGeoModel;

            // @ts-ignore FIXME:TS fix the "compatible with each other"?
            let itemStyleModel = regionModel.getModel(itemStyleAccessPath);
            // @ts-ignore FIXME:TS fix the "compatible with each other"?
            let hoverItemStyleModel = regionModel.getModel(hoverItemStyleAccessPath);
            let itemStyle = getFixedItemStyle(itemStyleModel);
            let hoverItemStyle = getFixedItemStyle(hoverItemStyleModel);

            // @ts-ignore FIXME:TS fix the "compatible with each other"?
            let labelModel = regionModel.getModel(labelAccessPath);
            // @ts-ignore FIXME:TS fix the "compatible with each other"?
            let hoverLabelModel = regionModel.getModel(hoverLabelAccessPath);

            let dataIdx;
            // Use the itemStyle in data if has data
            if (data) {
                dataIdx = data.indexOfName(region.name);
                // Only visual color of each item will be used. It can be encoded by dataRange
                // But visual color of series is used in symbol drawing
                //
                // Visual color for each series is for the symbol draw
                let visualColor = data.getItemVisual(dataIdx, 'color', true);
                if (visualColor) {
                    itemStyle.fill = visualColor;
                }
            }

            let transformPoint = function (point: number[]): number[] {
                return [
                    point[0] * scale[0] + position[0],
                    point[1] * scale[1] + position[1]
                ];
            };

            zrUtil.each(region.geometries, function (geometry) {
                if (geometry.type !== 'polygon') {
                    return;
                }
                let points = [];
                for (let i = 0; i < geometry.exterior.length; ++i) {
                    points.push(transformPoint(geometry.exterior[i]));
                }
                compoundPath.shape.paths.push(new graphic.Polygon({
                    segmentIgnoreThreshold: 1,
                    shape: {
                        points: points
                    }
                }));

                for (let i = 0; i < (geometry.interiors ? geometry.interiors.length : 0); ++i) {
                    let interior = geometry.interiors[i];
                    let points = [];
                    for (let j = 0; j < interior.length; ++j) {
                        points.push(transformPoint(interior[j]));
                    }
                    compoundPath.shape.paths.push(new graphic.Polygon({
                        segmentIgnoreThreshold: 1,
                        shape: {
                            points: points
                        }
                    }));
                }
            });

            compoundPath.setStyle(itemStyle);
            compoundPath.style.strokeNoScale = true;
            compoundPath.culling = true;

            // Label
            let showLabel = labelModel.get('show');
            let hoverShowLabel = hoverLabelModel.get('show');

            let isDataNaN = data && isNaN(data.get(data.mapDimension('value'), dataIdx) as number);
            let itemLayout = data && data.getItemLayout(dataIdx);
            // In the following cases label will be drawn
            // 1. In map series and data value is NaN
            // 2. In geo component
            // 4. Region has no series legendSymbol, which will be add a showLabel flag in mapSymbolLayout
            if (
                (isGeo || isDataNaN && (showLabel || hoverShowLabel))
                || (itemLayout && itemLayout.showLabel)
            ) {
                let query = !isGeo ? dataIdx : region.name;
                let labelFetcher;

                // Consider dataIdx not found.
                if (!data || dataIdx >= 0) {
                    labelFetcher = mapOrGeoModel;
                }

                let textEl = new graphic.Text({
                    position: transformPoint(region.center.slice()),
                    // FIXME
                    // label rotation is not support yet in geo or regions of series-map
                    // that has no data. The rotation will be effected by this `scale`.
                    // So needed to change to RectText?
                    scale: [1 / group.scale[0], 1 / group.scale[1]],
                    z2: 10,
                    silent: true
                });

                graphic.setLabelStyle<typeof query>(
                    textEl.style, textEl.hoverStyle = {}, labelModel, hoverLabelModel,
                    {
                        labelFetcher: labelFetcher,
                        labelDataIndex: query,
                        defaultText: region.name,
                        useInsideStyle: false
                    },
                    {
                        textAlign: 'center',
                        textVerticalAlign: 'middle'
                    }
                );

                regionGroup.add(textEl);
            }

            // setItemGraphicEl, setHoverStyle after all polygons and labels
            // are added to the rigionGroup
            if (data) {
                data.setItemGraphicEl(dataIdx, regionGroup);
            }
            else {
                const regionModel = mapOrGeoModel.getRegionModel(region.name);
                // Package custom mouse event for geo component
                graphic.getECData(compoundPath).eventData = {
                    componentType: 'geo',
                    componentIndex: mapOrGeoModel.componentIndex,
                    geoIndex: mapOrGeoModel.componentIndex,
                    name: region.name,
                    region: (regionModel && regionModel.option) || {}
                };
            }

            let groupRegions = regionGroup.__regions || (regionGroup.__regions = []);
            groupRegions.push(region);

            // @ts-ignore FIXME:TS fix the "compatible with each other"?
            regionGroup.highDownSilentOnTouch = !!mapOrGeoModel.get('selectedMode');
            graphic.setHoverStyle(regionGroup, hoverItemStyle);

            regionsGroup.add(regionGroup);
        });

        this._updateController(mapOrGeoModel, ecModel, api);

        this._updateMapSelectHandler(mapOrGeoModel, regionsGroup, api, fromView);

        updateMapSelected(mapOrGeoModel, regionsGroup);
    }

    remove(): void {
        this._regionsGroup.removeAll();
        this._backgroundGroup.removeAll();
        this._controller.dispose();
        this._mapName && geoSourceManager.removeGraphic(this._mapName, this.uid);
        this._mapName = null;
        this._controllerHost = {};
    }

    private _updateBackground(geo: Geo): void {
        let mapName = geo.map;

        if (this._mapName !== mapName) {
            zrUtil.each(geoSourceManager.makeGraphic(mapName, this.uid), function (root) {
                this._backgroundGroup.add(root);
            }, this);
        }

        this._mapName = mapName;
    }

    private _updateController(
        mapOrGeoModel: GeoModel | MapSeries, ecModel: GlobalModel, api: ExtensionAPI
    ): void {
        let geo = mapOrGeoModel.coordinateSystem;
        let controller = this._controller;
        let controllerHost = this._controllerHost;

        // @ts-ignore FIXME:TS
        controllerHost.zoomLimit = mapOrGeoModel.get('scaleLimit');
        controllerHost.zoom = geo.getZoom();

        // roamType is will be set default true if it is null
        // @ts-ignore FIXME:TS
        controller.enable(mapOrGeoModel.get('roam') || false);
        let mainType = mapOrGeoModel.mainType;

        function makeActionBase(): Payload {
            let action = {
                type: 'geoRoam',
                componentType: mainType
            } as Payload;
            action[mainType + 'Id'] = mapOrGeoModel.id;
            return action;
        }

        // @ts-ignore FIXME:TS
        controller.off('pan').on('pan', function (this: MapDraw, e) {
            this._mouseDownFlag = false;

            roamHelper.updateViewOnPan(controllerHost, e.dx, e.dy);

            api.dispatchAction(zrUtil.extend(makeActionBase(), {
                dx: e.dx,
                dy: e.dy
            }));
        }, this);

        // @ts-ignore FIXME:TS
        controller.off('zoom').on('zoom', function (this: MapDraw, e) {
            this._mouseDownFlag = false;

            roamHelper.updateViewOnZoom(controllerHost, e.scale, e.originX, e.originY);

            api.dispatchAction(zrUtil.extend(makeActionBase(), {
                zoom: e.scale,
                originX: e.originX,
                originY: e.originY
            }));

            if (this._updateGroup) {
                let scale = this.group.scale;
                this._regionsGroup.traverse(function (el) {
                    if (el.type === 'text') {
                        el.attr('scale', [1 / scale[0], 1 / scale[1]]);
                    }
                });
            }
        }, this);

        // @ts-ignore FIXME:TS
        controller.setPointerChecker(function (e, x, y) {
            return geo.getViewRectAfterRoam().contain(x, y)
                && !onIrrelevantElement(e, api, mapOrGeoModel);
        });
    }

    private _updateMapSelectHandler(
        mapOrGeoModel: GeoModel | MapSeries,
        regionsGroup: RegionsGroup,
        api: ExtensionAPI,
        fromView: MapView | GeoView
    ): void {
        let mapDraw = this;

        regionsGroup.off('click');
        regionsGroup.off('mousedown');

        // @ts-ignore FIXME:TS resolve type conflict
        if (mapOrGeoModel.get('selectedMode')) {

            regionsGroup.on('mousedown', function () {
                mapDraw._mouseDownFlag = true;
            });

            regionsGroup.on('click', function (e) {
                if (!mapDraw._mouseDownFlag) {
                    return;
                }
                mapDraw._mouseDownFlag = false;

                let el = e.target;
                while (!(el as RegionsGroup).__regions) {
                    el = el.parent;
                }
                if (!el) {
                    return;
                }

                let action = {
                    type: (mapOrGeoModel.mainType === 'geo' ? 'geo' : 'map') + 'ToggleSelect',
                    batch: zrUtil.map((el as RegionsGroup).__regions, function (region) {
                        return {
                            name: region.name,
                            from: fromView.uid
                        };
                    })
                } as Payload;
                action[mapOrGeoModel.mainType + 'Id'] = mapOrGeoModel.id;

                api.dispatchAction(action);

                updateMapSelected(mapOrGeoModel, regionsGroup);
            });
        }
    }

};

export default MapDraw;