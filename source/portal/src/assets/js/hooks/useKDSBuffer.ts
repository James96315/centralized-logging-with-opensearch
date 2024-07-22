/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License").
You may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import { resetKDSBuffer } from "reducer/configBufferKDS";
import { RootState } from "reducer/reducers";
import { AppDispatch } from "reducer/store";

export const useKDSBuffer = () => {
  const appDispatch = useDispatch<AppDispatch>();
  const kdsBuffer = useSelector((state: RootState) => state.kdsBuffer);
  useEffect(
    () => () => {
      appDispatch(resetKDSBuffer());
    },
    []
  );
  return kdsBuffer;
};
