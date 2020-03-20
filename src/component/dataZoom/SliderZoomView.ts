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

import {bind, each, defaults, isFunction, isString, indexOf} from 'zrender/src/core/util';
import * as eventTool from 'zrender/src/core/event';
import * as graphic from '../../util/graphic';
import * as throttle from '../../util/throttle';
import DataZoomView from './DataZoomView';
import {linearMap, asc} from '../../util/number';
import * as layout from '../../util/layout';
import sliderMove from '../helper/sliderMove';
import GlobalModel from '../../model/Global';
import ExtensionAPI from '../../ExtensionAPI';
import { LayoutOrient, Payload, ZRTextVerticalAlign, ZRTextAlign, ZRElementEvent, ParsedValue } from '../../util/types';
import SliderZoomModel from './SliderZoomModel';
import ComponentView from '../../view/Component';
import { parsePercent } from 'zrender/src/graphic/helper/text';
import { RectLike } from 'zrender/src/core/BoundingRect';
import Axis from '../../coord/Axis';
import SeriesModel from '../../model/Series';
import { AxisBaseModel } from '../../coord/AxisBaseModel';

const Rect = graphic.Rect;

// Constants
const DEFAULT_LOCATION_EDGE_GAP = 7;
const DEFAULT_FRAME_BORDER_WIDTH = 1;
const DEFAULT_FILLER_SIZE = 30;
const HORIZONTAL = 'horizontal';
const VERTICAL = 'vertical';
const LABEL_GAP = 5;
const SHOW_DATA_SHADOW_SERIES_TYPE = ['line', 'bar', 'candlestick', 'scatter'];


type Icon = ReturnType<typeof graphic.createIcon>;
interface Displayables {
    barGroup: graphic.Group;
    handles: [Icon, Icon];
    handleLabels: [graphic.Text, graphic.Text];
    filler: graphic.Rect;
}
class SliderZoomView extends DataZoomView {
    static type = 'dataZoom.slider';
    type = SliderZoomView.type;

    dataZoomModel: SliderZoomModel;

    private _displayables = {} as Displayables;

    private _orient: LayoutOrient;

    private _range: [number, number];

    /**
     * [coord of the first handle, coord of the second handle]
     */
    private _handleEnds: [number, number];

    /**
     * [length, thick]
     */
    private _size: [number, number];

    private _handleWidth: number;

    private _handleHeight: number;

    private _location: {x: number, y: number};

    private _dragging: boolean;

    private _dataShadowInfo: {
        thisAxis: Axis
        series: SeriesModel
        thisDim: string
        otherDim: string
        otherAxisInverse: boolean
    };

    init(ecModel: GlobalModel, api: ExtensionAPI) {
        this.api = api;
    }


    /**
     * @override
     */
    render(
        dataZoomModel: SliderZoomModel,
        ecModel: GlobalModel,
        api: ExtensionAPI,
        payload: Payload & {
            from: string
            type: string
        }
    ) {
        super.render.apply(this, arguments as any);

        throttle.createOrUpdate(
            this,
            '_dispatchZoomAction',
            this.dataZoomModel.get('throttle'),
            'fixRate'
        );

        this._orient = dataZoomModel.get('orient');

        if (this.dataZoomModel.get('show') === false) {
            this.group.removeAll();
            return;
        }

        // Notice: this._resetInterval() should not be executed when payload.type
        // is 'dataZoom', origin this._range should be maintained, otherwise 'pan'
        // or 'zoom' info will be missed because of 'throttle' of this.dispatchAction,
        if (!payload || payload.type !== 'dataZoom' || payload.from !== this.uid) {
            this._buildView();
        }

        this._updateView();
    }

    /**
     * @override
     */
    remove() {
        throttle.clear(this, '_dispatchZoomAction');
    }

    /**
     * @override
     */
    dispose() {
        super.dispose.apply(this, arguments as any);
        throttle.clear(this, '_dispatchZoomAction');
    }

    _buildView() {
        let thisGroup = this.group;

        thisGroup.removeAll();

        this._resetLocation();
        this._resetInterval();

        let barGroup = this._displayables.barGroup = new graphic.Group();

        this._renderBackground();

        this._renderHandle();

        this._renderDataShadow();

        thisGroup.add(barGroup);

        this._positionGroup();
    }

    /**
     * @private
     */
    _resetLocation() {
        let dataZoomModel = this.dataZoomModel;
        let api = this.api;

        // If some of x/y/width/height are not specified,
        // auto-adapt according to target grid.
        let coordRect = this._findCoordRect();
        let ecSize = {width: api.getWidth(), height: api.getHeight()};
        // Default align by coordinate system rect.
        let positionInfo = this._orient === HORIZONTAL
            ? {
                // Why using 'right', because right should be used in vertical,
                // and it is better to be consistent for dealing with position param merge.
                right: ecSize.width - coordRect.x - coordRect.width,
                top: (ecSize.height - DEFAULT_FILLER_SIZE - DEFAULT_LOCATION_EDGE_GAP),
                width: coordRect.width,
                height: DEFAULT_FILLER_SIZE
            }
            : { // vertical
                right: DEFAULT_LOCATION_EDGE_GAP,
                top: coordRect.y,
                width: DEFAULT_FILLER_SIZE,
                height: coordRect.height
            };

        // Do not write back to option and replace value 'ph', because
        // the 'ph' value should be recalculated when resize.
        let layoutParams = layout.getLayoutParams(dataZoomModel.option);

        // Replace the placeholder value.
        each(['right', 'top', 'width', 'height'] as const, function (name) {
            if (layoutParams[name] === 'ph') {
                layoutParams[name] = positionInfo[name];
            }
        });

        let layoutRect = layout.getLayoutRect(
            layoutParams,
            ecSize
        );

        this._location = {x: layoutRect.x, y: layoutRect.y};
        this._size = [layoutRect.width, layoutRect.height];
        this._orient === VERTICAL && this._size.reverse();
    }

    /**
     * @private
     */
    _positionGroup() {
        let thisGroup = this.group;
        let location = this._location;
        let orient = this._orient;

        // Just use the first axis to determine mapping.
        let targetAxisModel = this.dataZoomModel.getFirstTargetAxisModel();
        let inverse = targetAxisModel && targetAxisModel.get('inverse');

        let barGroup = this._displayables.barGroup;
        let otherAxisInverse = (this._dataShadowInfo || {}).otherAxisInverse;

        // Transform barGroup.
        barGroup.attr(
            (orient === HORIZONTAL && !inverse)
            ? {scale: otherAxisInverse ? [1, 1] : [1, -1]}
            : (orient === HORIZONTAL && inverse)
            ? {scale: otherAxisInverse ? [-1, 1] : [-1, -1]}
            : (orient === VERTICAL && !inverse)
            ? {scale: otherAxisInverse ? [1, -1] : [1, 1], rotation: Math.PI / 2}
            // Dont use Math.PI, considering shadow direction.
            : {scale: otherAxisInverse ? [-1, -1] : [-1, 1], rotation: Math.PI / 2}
        );

        // Position barGroup
        let rect = thisGroup.getBoundingRect([barGroup]);
        thisGroup.attr('position', [location.x - rect.x, location.y - rect.y]);
    }

    /**
     * @private
     */
    _getViewExtent() {
        return [0, this._size[0]];
    }

    _renderBackground() {
        let dataZoomModel = this.dataZoomModel;
        let size = this._size;
        let barGroup = this._displayables.barGroup;

        barGroup.add(new Rect({
            silent: true,
            shape: {
                x: 0, y: 0, width: size[0], height: size[1]
            },
            style: {
                fill: dataZoomModel.get('backgroundColor')
            },
            z2: -40
        }));

        // Click panel, over shadow, below handles.
        barGroup.add(new Rect({
            shape: {
                x: 0, y: 0, width: size[0], height: size[1]
            },
            style: {
                fill: 'transparent'
            },
            z2: 0,
            onclick: bind(this._onClickPanelClick, this)
        }));
    }

    _renderDataShadow() {
        let info = this._dataShadowInfo = this._prepareDataShadowInfo();

        if (!info) {
            return;
        }

        let size = this._size;
        let seriesModel = info.series;
        let data = seriesModel.getRawData();

        let otherDim: string = seriesModel.getShadowDim
            ? seriesModel.getShadowDim() // @see candlestick
            : info.otherDim;

        if (otherDim == null) {
            return;
        }

        let otherDataExtent = data.getDataExtent(otherDim);
        // Nice extent.
        let otherOffset = (otherDataExtent[1] - otherDataExtent[0]) * 0.3;
        otherDataExtent = [
            otherDataExtent[0] - otherOffset,
            otherDataExtent[1] + otherOffset
        ];
        let otherShadowExtent = [0, size[1]];

        let thisShadowExtent = [0, size[0]];

        let areaPoints = [[size[0], 0], [0, 0]];
        let linePoints: number[][] = [];
        let step = thisShadowExtent[1] / (data.count() - 1);
        let thisCoord = 0;

        // Optimize for large data shadow
        let stride = Math.round(data.count() / size[0]);
        let lastIsEmpty: boolean;
        data.each([otherDim], function (value: ParsedValue, index) {
            if (stride > 0 && (index % stride)) {
                thisCoord += step;
                return;
            }

            // FIXME
            // Should consider axis.min/axis.max when drawing dataShadow.

            // FIXME
            // 应该使用统一的空判断？还是在list里进行空判断？
            let isEmpty = value == null || isNaN(value as number) || value === '';
            // See #4235.
            let otherCoord = isEmpty
                ? 0 : linearMap(value as number, otherDataExtent, otherShadowExtent, true);

            // Attempt to draw data shadow precisely when there are empty value.
            if (isEmpty && !lastIsEmpty && index) {
                areaPoints.push([areaPoints[areaPoints.length - 1][0], 0]);
                linePoints.push([linePoints[linePoints.length - 1][0], 0]);
            }
            else if (!isEmpty && lastIsEmpty) {
                areaPoints.push([thisCoord, 0]);
                linePoints.push([thisCoord, 0]);
            }

            areaPoints.push([thisCoord, otherCoord]);
            linePoints.push([thisCoord, otherCoord]);

            thisCoord += step;
            lastIsEmpty = isEmpty;
        });

        let dataZoomModel = this.dataZoomModel;
        // let dataBackgroundModel = dataZoomModel.getModel('dataBackground');
        this._displayables.barGroup.add(new graphic.Polygon({
            shape: {points: areaPoints},
            style: defaults(
                {fill: dataZoomModel.get('dataBackgroundColor' as any)},
                dataZoomModel.getModel(['dataBackground', 'areaStyle']).getAreaStyle()
            ),
            silent: true,
            z2: -20
        }));
        this._displayables.barGroup.add(new graphic.Polyline({
            shape: {points: linePoints},
            style: dataZoomModel.getModel(['dataBackground', 'lineStyle']).getLineStyle(),
            silent: true,
            z2: -19
        }));
    }

    _prepareDataShadowInfo() {
        let dataZoomModel = this.dataZoomModel;
        let showDataShadow = dataZoomModel.get('showDataShadow');

        if (showDataShadow === false) {
            return;
        }

        // Find a representative series.
        let result: SliderZoomView['_dataShadowInfo'];
        let ecModel = this.ecModel;

        dataZoomModel.eachTargetAxis(function (dimNames, axisIndex) {
            let seriesModels = dataZoomModel
                .getAxisProxy(dimNames.name, axisIndex)
                .getTargetSeriesModels();

            each(seriesModels, function (seriesModel) {
                if (result) {
                    return;
                }

                if (showDataShadow !== true && indexOf(
                        SHOW_DATA_SHADOW_SERIES_TYPE, seriesModel.get('type')
                    ) < 0
                ) {
                    return;
                }

                let thisAxis = (ecModel.getComponent(dimNames.axis, axisIndex) as AxisBaseModel).axis;
                let otherDim = getOtherDim(dimNames.name);
                let otherAxisInverse;
                let coordSys = seriesModel.coordinateSystem;

                if (otherDim != null && coordSys.getOtherAxis) {
                    otherAxisInverse = coordSys.getOtherAxis(thisAxis).inverse;
                }

                otherDim = seriesModel.getData().mapDimension(otherDim);

                result = {
                    thisAxis: thisAxis,
                    series: seriesModel,
                    thisDim: dimNames.name,
                    otherDim: otherDim,
                    otherAxisInverse: otherAxisInverse
                };

            }, this);

        }, this);

        return result;
    }

    _renderHandle() {
        let displaybles = this._displayables;
        let handles: [Icon, Icon] = displaybles.handles = [null, null];
        let handleLabels: [graphic.Text, graphic.Text] = displaybles.handleLabels = [null, null];
        let barGroup = this._displayables.barGroup;
        let size = this._size;
        let dataZoomModel = this.dataZoomModel;

        barGroup.add(displaybles.filler = new Rect({
            draggable: true,
            cursor: getCursor(this._orient),
            drift: bind(this._onDragMove, this, 'all'),
            ondragstart: bind(this._showDataInfo, this, true),
            ondragend: bind(this._onDragEnd, this),
            onmouseover: bind(this._showDataInfo, this, true),
            onmouseout: bind(this._showDataInfo, this, false),
            style: {
                fill: dataZoomModel.get('fillerColor'),
                textPosition: 'inside'
            }
        }));

        // Frame border.
        barGroup.add(new Rect({
            silent: true,
            subPixelOptimize: true,
            shape: {
                x: 0,
                y: 0,
                width: size[0],
                height: size[1]
            },
            style: {
                stroke: dataZoomModel.get('dataBackgroundColor' as any) // deprecated option
                    || dataZoomModel.get('borderColor'),
                lineWidth: DEFAULT_FRAME_BORDER_WIDTH,
                fill: 'rgba(0,0,0,0)'
            }
        }));

        each([0, 1] as const, function (handleIndex) {
            let path = graphic.createIcon(
                dataZoomModel.get('handleIcon'),
                {
                    cursor: getCursor(this._orient),
                    draggable: true,
                    drift: bind(this._onDragMove, this, handleIndex),
                    ondragend: bind(this._onDragEnd, this),
                    onmouseover: bind(this._showDataInfo, this, true),
                    onmouseout: bind(this._showDataInfo, this, false)
                },
                {x: -1, y: 0, width: 2, height: 2}
            );

            let bRect = path.getBoundingRect();
            this._handleHeight = parsePercent(dataZoomModel.get('handleSize'), this._size[1]);
            this._handleWidth = bRect.width / bRect.height * this._handleHeight;

            path.setStyle(dataZoomModel.getModel('handleStyle').getItemStyle());
            let handleColor = dataZoomModel.get('handleColor' as any); // deprecated option
            // Compatitable with previous version
            if (handleColor != null) {
                path.style.fill = handleColor;
            }

            barGroup.add(handles[handleIndex] = path);

            let textStyleModel = dataZoomModel.textStyleModel;

            this.group.add(
                handleLabels[handleIndex] = new graphic.Text({
                silent: true,
                invisible: true,
                style: {
                    x: 0, y: 0, text: '',
                    textVerticalAlign: 'middle',
                    textAlign: 'center',
                    textFill: textStyleModel.getTextColor(),
                    textFont: textStyleModel.getFont()
                },
                z2: 10
            }));

        }, this);
    }

    private _resetInterval() {
        let range = this._range = this.dataZoomModel.getPercentRange();
        let viewExtent = this._getViewExtent();

        this._handleEnds = [
            linearMap(range[0], [0, 100], viewExtent, true),
            linearMap(range[1], [0, 100], viewExtent, true)
        ];
    }

    private _updateInterval(handleIndex: 0 | 1 | 'all', delta: number): boolean {
        let dataZoomModel = this.dataZoomModel;
        let handleEnds = this._handleEnds;
        let viewExtend = this._getViewExtent();
        let minMaxSpan = dataZoomModel.findRepresentativeAxisProxy().getMinMaxSpan();
        let percentExtent = [0, 100];

        sliderMove(
            delta,
            handleEnds,
            viewExtend,
            dataZoomModel.get('zoomLock') ? 'all' : handleIndex,
            minMaxSpan.minSpan != null
                ? linearMap(minMaxSpan.minSpan, percentExtent, viewExtend, true) : null,
            minMaxSpan.maxSpan != null
                ? linearMap(minMaxSpan.maxSpan, percentExtent, viewExtend, true) : null
        );

        let lastRange = this._range;
        let range = this._range = asc([
            linearMap(handleEnds[0], viewExtend, percentExtent, true),
            linearMap(handleEnds[1], viewExtend, percentExtent, true)
        ]);

        return !lastRange || lastRange[0] !== range[0] || lastRange[1] !== range[1];
    }

    private _updateView(nonRealtime?: boolean) {
        let displaybles = this._displayables;
        let handleEnds = this._handleEnds;
        let handleInterval = asc(handleEnds.slice());
        let size = this._size;

        each([0, 1] as const, function (handleIndex) {
            // Handles
            let handle = displaybles.handles[handleIndex];
            let handleHeight = this._handleHeight;
            (handle as graphic.Path).attr({
                scale: [handleHeight / 2, handleHeight / 2],
                position: [handleEnds[handleIndex], size[1] / 2 - handleHeight / 2]
            });
        }, this);

        // Filler
        displaybles.filler.setShape({
            x: handleInterval[0],
            y: 0,
            width: handleInterval[1] - handleInterval[0],
            height: size[1]
        });

        this._updateDataInfo(nonRealtime);
    }

    /**
     * @private
     */
    _updateDataInfo(nonRealtime?: boolean) {
        let dataZoomModel = this.dataZoomModel;
        let displaybles = this._displayables;
        let handleLabels = displaybles.handleLabels;
        let orient = this._orient;
        let labelTexts = ['', ''];

        // FIXME
        // date型，支持formatter，autoformatter（ec2 date.getAutoFormatter）
        if (dataZoomModel.get('showDetail')) {
            let axisProxy = dataZoomModel.findRepresentativeAxisProxy();

            if (axisProxy) {
                let axis = axisProxy.getAxisModel().axis;
                let range = this._range;

                let dataInterval = nonRealtime
                    // See #4434, data and axis are not processed and reset yet in non-realtime mode.
                    ? axisProxy.calculateDataWindow({
                        start: range[0], end: range[1]
                    }).valueWindow
                    : axisProxy.getDataValueWindow();

                labelTexts = [
                    this._formatLabel(dataInterval[0], axis),
                    this._formatLabel(dataInterval[1], axis)
                ];
            }
        }

        let orderedHandleEnds = asc(this._handleEnds.slice());

        setLabel.call(this, 0);
        setLabel.call(this, 1);

        function setLabel(this: SliderZoomView, handleIndex: 0 | 1) {
            // Label
            // Text should not transform by barGroup.
            // Ignore handlers transform
            let barTransform = graphic.getTransform(
                displaybles.handles[handleIndex].parent, this.group
            );
            let direction = graphic.transformDirection(
                handleIndex === 0 ? 'right' : 'left', barTransform
            );
            let offset = this._handleWidth / 2 + LABEL_GAP;
            let textPoint = graphic.applyTransform(
                [
                    orderedHandleEnds[handleIndex] + (handleIndex === 0 ? -offset : offset),
                    this._size[1] / 2
                ],
                barTransform
            );
            handleLabels[handleIndex].setStyle({
                x: textPoint[0],
                y: textPoint[1],
                textVerticalAlign: orient === HORIZONTAL ? 'middle' : direction as ZRTextVerticalAlign,
                textAlign: orient === HORIZONTAL ? direction as ZRTextAlign : 'center',
                text: labelTexts[handleIndex]
            });
        }
    }

    _formatLabel(value: ParsedValue, axis: Axis) {
        let dataZoomModel = this.dataZoomModel;
        let labelFormatter = dataZoomModel.get('labelFormatter');

        let labelPrecision = dataZoomModel.get('labelPrecision');
        if (labelPrecision == null || labelPrecision === 'auto') {
            labelPrecision = axis.getPixelPrecision();
        }

        let valueStr = (value == null || isNaN(value as number))
            ? ''
            // FIXME Glue code
            : (axis.type === 'category' || axis.type === 'time')
                ? axis.scale.getLabel(Math.round(value as number))
                // param of toFixed should less then 20.
                : (value as number).toFixed(Math.min(labelPrecision as number, 20));

        return isFunction(labelFormatter)
            ? labelFormatter(value as number, valueStr)
            : isString(labelFormatter)
            ? labelFormatter.replace('{value}', valueStr)
            : valueStr;
    }

    /**
     * @private
     * @param showOrHide true: show, false: hide
     */
    _showDataInfo(showOrHide?: boolean) {
        // Always show when drgging.
        showOrHide = this._dragging || showOrHide;

        let handleLabels = this._displayables.handleLabels;
        handleLabels[0].attr('invisible', !showOrHide);
        handleLabels[1].attr('invisible', !showOrHide);
    }

    _onDragMove(handleIndex: 0 | 1 | 'all', dx: number, dy: number, event: ZRElementEvent) {
        this._dragging = true;

        // For mobile device, prevent screen slider on the button.
        eventTool.stop(event.event);

        // Transform dx, dy to bar coordination.
        let barTransform = this._displayables.barGroup.getLocalTransform();
        let vertex = graphic.applyTransform([dx, dy], barTransform, true);

        let changed = this._updateInterval(handleIndex, vertex[0]);

        let realtime = this.dataZoomModel.get('realtime');

        this._updateView(!realtime);

        // Avoid dispatch dataZoom repeatly but range not changed,
        // which cause bad visual effect when progressive enabled.
        changed && realtime && this._dispatchZoomAction();
    }

    _onDragEnd() {
        this._dragging = false;
        this._showDataInfo(false);

        // While in realtime mode and stream mode, dispatch action when
        // drag end will cause the whole view rerender, which is unnecessary.
        let realtime = this.dataZoomModel.get('realtime');
        !realtime && this._dispatchZoomAction();
    }

    _onClickPanelClick(e: ZRElementEvent) {
        let size = this._size;
        let localPoint = this._displayables.barGroup.transformCoordToLocal(e.offsetX, e.offsetY);

        if (localPoint[0] < 0 || localPoint[0] > size[0]
            || localPoint[1] < 0 || localPoint[1] > size[1]
        ) {
            return;
        }

        let handleEnds = this._handleEnds;
        let center = (handleEnds[0] + handleEnds[1]) / 2;

        let changed = this._updateInterval('all', localPoint[0] - center);
        this._updateView();
        changed && this._dispatchZoomAction();
    }

    /**
     * This action will be throttled.
     * @private
     */
    _dispatchZoomAction() {
        let range = this._range;

        this.api.dispatchAction({
            type: 'dataZoom',
            from: this.uid,
            dataZoomId: this.dataZoomModel.id,
            start: range[0],
            end: range[1]
        });
    }

    /**
     * @private
     */
    _findCoordRect() {
        // Find the grid coresponding to the first axis referred by dataZoom.
        let rect: RectLike;
        each(this.getTargetCoordInfo(), function (coordInfoList) {
            if (!rect && coordInfoList.length) {
                let coordSys = coordInfoList[0].model.coordinateSystem;
                rect = coordSys.getRect && coordSys.getRect();
            }
        });
        if (!rect) {
            let width = this.api.getWidth();
            let height = this.api.getHeight();
            rect = {
                x: width * 0.2,
                y: height * 0.2,
                width: width * 0.6,
                height: height * 0.6
            };
        }

        return rect;
    }

}

function getOtherDim(thisDim: 'x' | 'y' | 'radius' | 'angle' | 'single' | 'z') {
    // FIXME
    // 这个逻辑和getOtherAxis里一致，但是写在这里是否不好
    let map = {x: 'y', y: 'x', radius: 'angle', angle: 'radius'};
    return map[thisDim as 'x' | 'y' | 'radius' | 'angle'];
}

function getCursor(orient: LayoutOrient) {
    return orient === 'vertical' ? 'ns-resize' : 'ew-resize';
}

ComponentView.registerClass(SliderZoomView);

export default SliderZoomView;